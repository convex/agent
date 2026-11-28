import { expect, test, vi } from "vitest";
import { defineTestApp } from "convex-test";
import { createFunctionHandle, defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { isStepCount, type GenerateObjectResult } from "ai";
import { z } from "zod/v4";
import componentTest from "../../test.js";
import {
  Agent,
  createTool,
  saveMessage,
  vOnSaveMessagesArgs,
  type OnSaveMessagesArgs,
} from "../index.js";
import { mockModel } from "./mockModel.js";

// https://github.com/convex/agent/issues/147

const app = defineTestApp({
  schema: defineSchema({
    reports: defineTable(vOnSaveMessagesArgs).index("by_threadId", [
      "threadId",
    ]),
    failing: defineTable({ threadId: v.string() }).index("by_threadId", [
      "threadId",
    ]),
  }),
  components: { agent: componentTest },
});
const component = app.components.agent;

// Throws for threads marked failing, after recording.
const record = app.internalMutation({
  args: vOnSaveMessagesArgs,
  handler: async (ctx, { threadId, messages }) => {
    await ctx.db.insert("reports", { threadId, messages });
    const failing = await ctx.db
      .query("failing")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .first();
    if (failing) throw new Error(`hook failed for ${threadId}`);
    return null;
  },
});

const lookup = createTool({
  description: "Looks something up",
  inputSchema: z.object({ q: z.string() }),
  // Convex refuses `$` keys, so the step holding this result is resent encoded.
  execute: async (_ctx, input) => ({ $ref: `#/found/${input.q}` }),
});

type Hook = "record" | "none";

const agentWith = ({
  hook = "record",
  fails = false,
}: { hook?: Hook; fails?: boolean } = {}): Agent =>
  new Agent(component, {
    name: "hooked",
    tools: { lookup },
    stopWhen: isStepCount(3),
    onSaveMessages: hook === "none" ? undefined : internal.hook.record,
    languageModel: mockModel(
      fails
        ? { fail: { error: "provider down" } }
        : {
            contentSteps: [
              [
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "lookup",
                  input: JSON.stringify({ q: "x" }),
                },
              ],
              [{ type: "text", text: "reply" }],
            ],
          },
    ),
  });

const vHook = v.optional(v.union(v.literal("record"), v.literal("none")));

const createThread = app.mutation({
  args: {},
  handler: async (ctx): Promise<string> =>
    (await ctx.runMutation(component.threads.createThread, {}))._id,
});

const generate = app.action({
  args: {
    threadId: v.string(),
    fails: v.optional(v.boolean()),
  },
  handler: async (ctx, { threadId, ...opts }) => {
    await agentWith(opts)
      .generateText(ctx, { threadId }, { prompt: "hello" })
      .catch((e) => {
        if (!opts.fails) throw e;
      });
    return null;
  },
});

const save = app.mutation({
  args: {
    threadId: v.string(),
    text: v.optional(v.string()),
    pending: v.optional(v.boolean()),
    restart: v.optional(v.boolean()),
    promptMessageId: v.optional(v.string()),
    hook: vHook,
  },
  handler: async (ctx, args): Promise<string> => {
    const agent = agentWith({ hook: args.hook });
    const { messages } = await agent.saveMessages(ctx, {
      threadId: args.threadId,
      promptMessageId: args.promptMessageId,
      messages: [
        args.pending
          ? { role: "assistant", content: [] }
          : { role: "user", content: args.text ?? "hi" },
      ],
      metadata: args.pending ? [{ status: "pending" }] : undefined,
      failPendingSteps: args.restart,
      skipEmbeddings: true,
    });
    return messages[0]._id;
  },
});

const finalize = app.mutation({
  args: {
    messageId: v.string(),
    failed: v.boolean(),
    // Scheduled-argument bytes to leave before finalizing.
    scheduleRoom: v.optional(v.number()),
  },
  handler: async (ctx, { messageId, failed, scheduleRoom }) => {
    if (scheduleRoom !== undefined) {
      const remaining = async () =>
        (await ctx.meta.getTransactionMetrics()).scheduledFunctionArgsBytes
          .remaining;
      const before = await remaining();
      await ctx.scheduler.runAfter(0, internal.hook.noop, { filler: "" });
      const overhead = before - (await remaining());
      for (let left = (await remaining()) - scheduleRoom; left > 0; ) {
        const size = Math.min(left, 1 << 20);
        await ctx.scheduler.runAfter(0, internal.hook.noop, {
          filler: "x".repeat(size - overhead),
        });
        left -= size;
      }
      expect(await remaining()).toBe(scheduleRoom);
    }
    await agentWith().finalizeMessage(ctx, {
      messageId,
      result: failed
        ? { status: "failed", error: "stopped" }
        : { status: "success" },
    });
    return null;
  },
});

const update = app.mutation({
  args: { messageId: v.string() },
  handler: async (ctx, { messageId }) => {
    await agentWith().updateMessage(ctx, {
      messageId,
      patch: {
        message: { role: "user", content: "edited" },
        status: "success",
      },
    });
    return null;
  },
});

// An approval's response, then a client tool's output, each to its own request.
const respond = app.mutation({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const agent = agentWith();
    const request = (content: object[]) =>
      agent.saveMessage(ctx, {
        threadId,
        skipEmbeddings: true,
        message: { role: "assistant", content } as never,
      });
    const call = { type: "tool-call", input: { q: "x" } };
    await request([
      { ...call, toolCallId: "call-a", toolName: "lookup" },
      { type: "tool-approval-request", toolCallId: "call-a", approvalId: "a" },
    ]);
    await agent.approveToolCall(ctx, { threadId, approvalId: "a" });
    await request([{ ...call, toolCallId: "call-c", toolName: "pick" }]);
    await agent.addToolOutput(ctx, {
      threadId,
      tool: "pick",
      toolCallId: "call-c",
      output: "picked",
      tools: {
        pick: createTool({
          description: "Picks on the client",
          inputSchema: z.object({ q: z.string() }),
        }),
      },
    });
    return null;
  },
});

const remove = app.mutation({
  args: {
    threadId: v.string(),
    messageIds: v.optional(v.array(v.string())),
    range: v.optional(v.boolean()),
    thread: v.optional(v.boolean()),
    pageSize: v.optional(v.number()),
    hook: vHook,
  },
  handler: async (ctx, args) => {
    const agent = agentWith({ hook: args.hook });
    if (args.messageIds?.length === 1) {
      await agent.deleteMessage(ctx, { messageId: args.messageIds[0] });
    } else if (args.messageIds) {
      await agent.deleteMessages(ctx, { messageIds: args.messageIds });
    } else if (args.range) {
      await agent.deleteMessageRange(ctx, {
        threadId: args.threadId,
        startOrder: 0,
        endOrder: 100,
      });
    } else if (args.thread) {
      await agent.deleteThreadAsync(ctx, {
        threadId: args.threadId,
        pageSize: args.pageSize,
      });
    }
    return null;
  },
});

const saveStepAndObject = app.action({
  args: { threadId: v.string(), source: v.string() },
  handler: async (ctx, { threadId, source }) => {
    const { steps } = await agentWith({ hook: "none" }).generateText(
      ctx,
      { threadId: source },
      { prompt: "hello" },
    );
    const agent = agentWith();
    const { messageId: promptMessageId } = await agentWith({
      hook: "none",
    }).saveMessage(ctx, { threadId, prompt: "hello", skipEmbeddings: true });
    await agent.saveStep(ctx, { threadId, promptMessageId, step: steps[0] });
    await agent.saveObject(ctx, {
      userId: undefined,
      threadId,
      promptMessageId,
      model: undefined,
      provider: undefined,
      result: {
        object: { answer: 42 },
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      } as unknown as GenerateObjectResult<unknown>,
    });
    return null;
  },
});

const seedThreads = app.mutation({
  args: { count: v.number() },
  handler: async (ctx, { count }): Promise<string[]> => {
    const messageIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const { _id: threadId } = await ctx.runMutation(
        component.threads.createThread,
        {},
      );
      const { messages } = await ctx.runMutation(
        component.messages.addMessages,
        { threadId, messages: [{ message: { role: "user", content: "hi" } }] },
      );
      messageIds.push(messages[0]._id);
    }
    return messageIds;
  },
});

const noop = app.internalMutation({
  args: { filler: v.optional(v.string()) },
  handler: async () => null,
});

const saveAtDeletedPrompt = app.mutation({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }): Promise<number> => {
    const { messageId: promptMessageId } = await saveMessage(ctx, component, {
      threadId,
      prompt: "gone",
    });
    await ctx.runMutation(component.messages.deleteByIds, {
      messageIds: [promptMessageId],
    });
    const { messages } = await ctx.runMutation(component.messages.addMessages, {
      threadId,
      promptMessageId,
      abandonIfPromptMissing: true,
      failPendingSteps: true,
      messages: [{ message: { role: "assistant", content: "late" } }],
      onSaveMessages: await createFunctionHandle(internal.hook.record),
    });
    return messages.length;
  },
});

const read = app.query({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const { page } = await ctx.runQuery(
      component.messages.listMessagesByThreadId,
      {
        threadId,
        order: "asc",
        paginationOpts: { cursor: null, numItems: 100 },
      },
    );
    const reports = await ctx.db
      .query("reports")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .collect();
    return {
      messages: page.map((m) => ({
        messageId: m._id,
        order: m.order,
        stepOrder: m.stepOrder,
        status: m.status,
      })),
      reports: reports.map((r) => r.messages),
    };
  },
});

const { api, internal, createTest } = app.defineModules({
  hook: {
    record,
    createThread,
    generate,
    save,
    finalize,
    update,
    respond,
    remove,
    read,
    saveStepAndObject,
    seedThreads,
    noop,
    saveAtDeletedPrompt,
  },
});

type Reported = OnSaveMessagesArgs["messages"][number];
type Message = Omit<Reported, "kind">;

async function setup(opts: Parameters<typeof createTest>[0] = {}) {
  const t = createTest(opts);
  const threadId = await t.mutation(api.hook.createThread, {});
  const state = async (id = threadId) => {
    await t.finishAllScheduledFunctions(() => {});
    return t.query(api.hook.read, { threadId: id });
  };
  return { t, threadId, state };
}

const as = (kind: Reported["kind"], m: Message): Reported => ({ kind, ...m });

test("a generation reports its prompt and pending reply, then each step once, resent or not", async () => {
  const { t, threadId, state } = await setup();
  await t.action(api.hook.generate, { threadId });
  const { messages, reports } = await state();
  const [prompt, call, result, final] = messages;
  expect(messages.map((m) => m.status)).toEqual([
    "success",
    "success",
    "success",
    "success",
  ]);
  const { page } = await t.query(component.messages.listMessagesByThreadId, {
    threadId,
    order: "asc",
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(JSON.stringify(page[2].message)).toContain("convexAgent");
  expect(reports).toEqual([
    [as("insert", prompt), as("insert", { ...call, status: "pending" })],
    [
      as("update", call),
      as("insert", result),
      as("insert", { ...final, status: "pending" }),
    ],
    [as("update", final)],
  ]);
});

async function pendingWithStream(
  t: Awaited<ReturnType<typeof setup>>["t"],
  threadId: string,
  parts: object[],
) {
  const pending = await t.mutation(api.hook.save, { threadId, pending: true });
  const streamId = await t.mutation(component.streams.create, {
    threadId,
    order: 0,
    stepOrder: 0,
    format: "UIMessageChunk",
  });
  await t.mutation(component.streams.addDelta, {
    streamId,
    start: 0,
    end: parts.length,
    parts,
  });
  return pending;
}

const recoverable = [
  { type: "start" },
  { type: "start-step" },
  {
    type: "tool-input-available",
    toolCallId: "call-1",
    toolName: "lookup",
    input: { q: "x" },
  },
  { type: "tool-output-available", toolCallId: "call-1", output: "found" },
  { type: "finish-step" },
  { type: "start-step" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "partial" },
];

test("a failed reply is reported at its final status", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { t, threadId, state } = await setup();
    await t.action(api.hook.generate, { threadId, fails: true });
    const { messages, reports } = await state();
    const [prompt, reply] = messages;
    expect(reply.status).toBe("failed");
    expect(reports).toEqual([
      [as("insert", prompt), as("insert", { ...reply, status: "pending" })],
      [as("update", reply)],
    ]);

    const unrecoverable = await t.mutation(api.hook.createThread, {});
    const pending = await pendingWithStream(t, unrecoverable, [
      { type: "text-delta", id: "missing", delta: "partial" },
    ]);
    await t.mutation(api.hook.finalize, { messageId: pending, failed: false });
    const stream = await state(unrecoverable);
    expect(stream.messages[0].status).toBe("failed");
    expect(stream.reports.at(-1)).toEqual([as("update", stream.messages[0])]);

    const abandoned = await t.mutation(api.hook.createThread, {});
    await t.mutation(api.hook.save, {
      threadId: abandoned,
      pending: true,
      hook: "none",
    });
    expect(
      await t.mutation(api.hook.saveAtDeletedPrompt, { threadId: abandoned }),
    ).toBe(0);
    const late = await state(abandoned);
    expect(late.messages[0].status).toBe("failed");
    expect(late.reports).toEqual([[as("update", late.messages[0])]]);
  } finally {
    error.mockRestore();
  }
});

test("saving, restarting and updating are reported", async () => {
  const { t, threadId, state } = await setup();
  const pending = await t.mutation(api.hook.save, { threadId, pending: true });
  const next = await t.mutation(api.hook.save, { threadId, restart: true });
  await t.mutation(api.hook.update, { messageId: next });
  const { messages, reports } = await state();
  const byId = (id: string) => messages.find((m) => m.messageId === id)!;
  expect(byId(pending).status).toBe("failed");
  expect(reports).toEqual([
    [as("insert", { ...byId(pending), status: "pending" })],
    [as("update", byId(pending)), as("insert", byId(next))],
    [as("update", byId(next))],
  ]);
});

test("approvals, client tool outputs, and steps or objects saved directly are reported", async () => {
  const { t, threadId, state } = await setup();
  await t.mutation(api.hook.respond, { threadId });
  const tools = await state();
  expect(tools.reports).toEqual(tools.messages.map((m) => [as("insert", m)]));

  const direct = await t.mutation(api.hook.createThread, {});
  const source = await t.mutation(api.hook.createThread, {});
  await t.action(api.hook.saveStepAndObject, { threadId: direct, source });
  const { messages, reports } = await state(direct);
  const [, ...saved] = messages;
  expect(reports.length).toBe(2);
  expect(reports.flat()).toEqual(saved.map((m) => as("insert", m)));
});

test("finalizing reports every message recovered from the stream once", async () => {
  const { t, threadId, state } = await setup();
  const pending = await pendingWithStream(t, threadId, recoverable);
  await t.mutation(api.hook.finalize, { messageId: pending, failed: true });
  await t.mutation(api.hook.finalize, { messageId: pending, failed: true });
  const { messages, reports } = await state();
  expect(messages.length).toBeGreaterThan(1);
  expect(messages[0].messageId).toBe(pending);
  expect(reports).toEqual([
    [as("insert", { ...messages[0], status: "pending" })],
    messages.map((m, i) => as(i === 0 ? "update" : "insert", m)),
  ]);
});

// Room for a one-message report, not for the recovered batch's.
test("a finalize that recovers stream output fails whole when its report can't be scheduled", async () => {
  const { t, threadId, state } = await setup({ transactionLimits: true });
  const pending = await pendingWithStream(t, threadId, recoverable);
  const { messages: before } = await state();
  await expect(
    t.mutation(api.hook.finalize, {
      messageId: pending,
      failed: true,
      scheduleRoom: 300,
    }),
  ).rejects.toThrow("Scheduled function arguments too large");
  expect(await state()).toEqual({
    messages: before,
    reports: [[as("insert", { ...before[0], status: "pending" })]],
  });
});

test("deleting a message, messages, a range or a thread is reported", async () => {
  const { t, threadId, state } = await setup();
  const ids = [];
  for (const text of ["a", "b", "c", "d", "e"]) {
    ids.push(await t.mutation(api.hook.save, { threadId, text }));
  }
  const { messages: saved } = await state();
  await t.mutation(api.hook.remove, { threadId, messageIds: [ids[0]] });
  await t.mutation(api.hook.remove, { threadId, messageIds: ids.slice(1, 3) });
  await t.mutation(api.hook.remove, { threadId, range: true });
  const { messages, reports } = await state();
  expect(messages).toEqual([]);
  expect(reports.slice(5)).toEqual([
    [as("delete", saved[0])],
    [as("delete", saved[1]), as("delete", saved[2])],
    [as("delete", saved[3]), as("delete", saved[4])],
  ]);

  const thread = await t.mutation(api.hook.createThread, {});
  for (const text of ["a", "b", "c"]) {
    await t.mutation(api.hook.save, { threadId: thread, text });
  }
  const { messages: inThread } = await state(thread);
  await t.mutation(api.hook.remove, {
    threadId: thread,
    thread: true,
    pageSize: 2,
  });
  const deleted = await state(thread);
  expect(deleted.messages).toEqual([]);
  expect(deleted.reports.slice(3)).toEqual([
    inThread.slice(0, 2).map((m) => as("delete", m)),
    [as("delete", inThread[2])],
  ]);
});

test("deleting a prompt reports the pending reply it fails", async () => {
  const { t, threadId, state } = await setup();
  const prompt = await t.mutation(api.hook.save, { threadId });
  await t.mutation(api.hook.save, {
    threadId,
    pending: true,
    promptMessageId: prompt,
  });
  const { messages: saved } = await state();
  await t.mutation(api.hook.remove, { threadId, messageIds: [prompt] });
  const { reports } = await state();
  expect(reports.slice(2)).toEqual([
    [as("update", { ...saved[1], status: "failed" })],
    [as("delete", saved[0])],
  ]);
});

// Each thread's report is its own scheduled function, under Convex's limit of
// 1,000 per mutation.
test("a delete spanning more than 1,000 threads fails whole", async () => {
  const { t } = await setup({ transactionLimits: true });
  const messageIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    messageIds.push(
      ...(await t.mutation(api.hook.seedThreads, { count: i < 4 ? 250 : 1 })),
    );
  }
  await expect(
    t.mutation(api.hook.remove, { threadId: "", messageIds }),
  ).rejects.toThrow("Scheduled too many functions");
  const [last] = await t.query(component.messages.getMessagesByIds, {
    messageIds: messageIds.slice(-1),
  });
  expect(last?._id).toBe(messageIds.at(-1));
}, 30_000);

test("a thread whose hook throws doesn't drop another thread's report", async () => {
  const { t, threadId, state } = await setup();
  const other = await t.mutation(api.hook.createThread, {});
  const a = await t.mutation(api.hook.save, { threadId, hook: "none" });
  const b = await t.mutation(api.hook.save, { threadId: other, hook: "none" });
  await t.run((ctx) => ctx.db.insert("failing", { threadId: other }));
  const { messages } = await state();
  await t.mutation(api.hook.remove, { threadId, messageIds: [a, b] });
  expect((await state()).reports).toEqual([[as("delete", messages[0])]]);
  expect((await state(other)).reports).toEqual([]);
});
