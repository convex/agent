import { beforeEach, expect, test } from "vitest";
import { v } from "convex/values";
import {
  defineSchema,
  defineTable,
  getFunctionAddress,
  makeFunctionReference,
  type FunctionReference,
} from "convex/server";
import { defineTestApp } from "convex-test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { stepCountIs, streamText } from "ai";
import { z } from "zod/v4";
import { Agent, createThread, createTool } from "../index.js";
import type { MessageDoc } from "../../validators.js";
import componentTest from "../../test.js";
import { mockModel, type MockLanguageModel } from "./mockModel.js";
import type { ActionCtx } from "./types.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const forever = new Promise<void>(() => {});
const toolStep = (id: string, tool = "place"): LanguageModelV4StreamPart[] => [
  { type: "stream-start", warnings: [] },
  {
    type: "tool-call",
    toolCallId: id,
    toolName: tool,
    input: JSON.stringify({ item: id }),
  },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "" }, usage },
];
function scripted(...steps: (LanguageModelV4StreamPart[] | string)[]) {
  let call = 0;
  return mockModel({
    doStream: async () => {
      const step = steps[call++] ?? "Done.";
      const parts: LanguageModelV4StreamPart[] = Array.isArray(step)
        ? step
        : [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: step },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage,
            },
          ];
      return {
        stream: new ReadableStream({
          start(controller) {
            parts.forEach((part) => controller.enqueue(part));
            controller.close();
          },
        }),
      };
    },
  }) as MockLanguageModel;
}
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

const app = defineTestApp({
  schema: defineSchema({
    orders: defineTable({ item: v.string(), key: v.string() }),
  }),
  components: { agent: componentTest },
});
const components = app.components;
type Ids = { threadId: string; promptMessageId: string };
const generate = makeFunctionReference<"action", Ids>("durable:generate");
const attempts: ((ctx: ActionCtx, ids: Ids) => Promise<void>)[] = [];
const { createTest } = app.defineModules({
  durable: {
    generate: app.action({
      args: { threadId: v.string(), promptMessageId: v.string() },
      handler: async (ctx, ids) => {
        await attempts.shift()!(ctx as ActionCtx, ids);
      },
    }),
    place: app.internalMutation({
      args: { item: v.string(), key: v.string() },
      handler: async (ctx, order) => {
        await ctx.db.insert("orders", order);
        return `placed ${order.item}`;
      },
    }),
  },
});
const place = makeFunctionReference<"mutation">(
  "durable:place",
) as unknown as FunctionReference<
  "mutation",
  "internal",
  { item: string; key: string },
  string
>;
const agent = new Agent(components.agent, {
  name: "durable",
  languageModel: mockModel(),
  tools: {
    place: createTool({
      inputSchema: z.object({ item: z.string() }),
      mutation: (ctx, { item }, { toolCallId }): Promise<string> =>
        ctx.runMutation(place, { item, key: `${ctx.messageId}:${toolCallId}` }),
    }),
    approvedPlace: createTool({
      inputSchema: z.object({ item: z.string() }),
      needsApproval: true,
      mutation: (ctx, { item }, { toolCallId }): Promise<string> =>
        ctx.runMutation(place, { item, key: `${ctx.messageId}:${toolCallId}` }),
    }),
  },
  stopWhen: stepCountIs(3),
});

// How each generation, by name, ran its mutation tool calls.
let seen: Record<string, { durable: number; plain: number }> = {};
beforeEach(() => {
  attempts.length = 0;
  seen = {};
});
function watched(ctx: ActionCtx, name: string): ActionCtx {
  const log = (seen[name] ??= { durable: 0, plain: 0 });
  const runMutation = ((ref: never, args: object) => {
    const address = getFunctionAddress(ref);
    const fn = (address.name ?? address.reference ?? "handle").replace(
      "_reference/childComponent/agent/",
      "",
    );
    if (fn.endsWith("runToolMutation")) log.durable++;
    if (fn === "durable:place") log.plain++;
    return ctx.runMutation(ref, args as never);
  }) as ActionCtx["runMutation"];
  return { ...ctx, runMutation };
}
const classOf = (name: string) => {
  const log = seen[name];
  if (!log || log.durable + log.plain === 0) return "none";
  if (log.durable && log.plain) return "mixed";
  return log.durable ? "durable" : "plain";
};
const deltas = {
  saveStreamDeltas: { throttleMs: 0, chunking: (b: string) => b || null },
};
const run = (
  ctx: ActionCtx,
  name: string,
  model: MockLanguageModel,
  threadId: string,
  more: object = {},
) =>
  agent
    .streamText(watched(ctx, name), { threadId }, { model, ...more }, deltas)
    .then((result) => result.consumeStream());

async function submitted() {
  const t = createTest();
  const threadId = await t.mutation((ctx) =>
    createThread(ctx, components.agent, {}),
  );
  const { messageId } = await t.mutation((ctx) =>
    agent.saveMessage(ctx, { threadId, prompt: "Go.", generate }),
  );
  const ids = { threadId, promptMessageId: messageId };
  const docs = async (thread = threadId) =>
    (
      await t.query((ctx) =>
        ctx.runQuery(components.agent.messages.listMessagesByThreadId, {
          threadId: thread,
          order: "asc",
        }),
      )
    ).page as MessageDoc[];
  return { t, ids, docs };
}

test("the job's own generation is durable", async () => {
  attempts.push((ctx, ids) =>
    run(ctx, "own", scripted(toolStep("o1")), ids.threadId, ids),
  );
  const { t } = await submitted();
  await t.finishAllScheduledFunctions(() => {});
  expect(classOf("own")).toBe("durable");
});

test("a plain generation inside a durable job's action, in the same thread, is plain", async () => {
  attempts.push(async (ctx, ids) => {
    await run(ctx, "side", scripted(toolStep("s1")), ids.threadId, {
      prompt: "Aside.",
    });
    await run(ctx, "own", scripted(toolStep("o1")), ids.threadId, ids);
  });
  const { t } = await submitted();
  await t.finishAllScheduledFunctions(() => {});
  expect(classOf("side")).toBe("plain");
  expect(classOf("own")).toBe("durable");
});

test("a plain generation inside a durable job's action, in another thread, is plain", async () => {
  attempts.push(async (ctx, ids) => {
    const other = await createThread(ctx, components.agent, {});
    await run(ctx, "side", scripted(toolStep("s1")), other, {
      prompt: "Elsewhere.",
    });
    await run(ctx, "own", scripted(toolStep("o1")), ids.threadId, ids);
  });
  const { t } = await submitted();
  await t.finishAllScheduledFunctions(() => {});
  expect(classOf("side")).toBe("plain");
  expect(classOf("own")).toBe("durable");
});

test("a send from inside a durable job starts a durable turn, and leaves the sender durable", async () => {
  let sent: Ids | undefined;
  attempts.push(async (ctx, ids) => {
    const other = await createThread(ctx, components.agent, {});
    const { messageId, jobId } = await agent.saveMessage(ctx, {
      threadId: other,
      prompt: "Go there.",
      generate,
    });
    expect(jobId).toBeTruthy();
    sent = { threadId: other, promptMessageId: messageId };
    // A generation at the sent turn's prompt, from a job that doesn't hold
    // it, takes it over.
    await run(ctx, "inline", scripted(toolStep("i1")), other, sent);
    await run(ctx, "sender", scripted(toolStep("o1")), ids.threadId, ids);
  });
  attempts.push((ctx, ids) =>
    run(ctx, "sent", scripted(toolStep("n1")), ids.threadId, ids),
  );
  const { t } = await submitted();
  await t.finishAllScheduledFunctions(() => {});
  expect(classOf("inline")).toBe("plain");
  expect(classOf("sender")).toBe("durable");
  // The takeover ended the sent turn, so its job, if it ran, was refused.
  expect(["none", "durable"]).toContain(classOf("sent"));
});

test("a send from inside a durable job hands its new job a durable generation", async () => {
  attempts.push(async (ctx, ids) => {
    const other = await createThread(ctx, components.agent, {});
    await agent.saveMessage(ctx, {
      threadId: other,
      prompt: "Go there.",
      generate,
    });
    await run(ctx, "sender", scripted(toolStep("o1")), ids.threadId, ids);
  });
  attempts.push((ctx, ids) =>
    run(ctx, "sent", scripted(toolStep("n1")), ids.threadId, ids),
  );
  const { t } = await submitted();
  await t.finishAllScheduledFunctions(() => {});
  expect(classOf("sender")).toBe("durable");
  expect(classOf("sent")).toBe("durable");
});

test("a retry's generation is durable", async () => {
  attempts.push(async () => {
    throw new Error("crashed");
  });
  attempts.push((ctx, ids) =>
    run(ctx, "retry", scripted(toolStep("r1")), ids.threadId, ids),
  );
  const { t, ids } = await submitted();
  await t.finishAllScheduledFunctions(() => {});
  expect(
    await t.mutation((ctx) => agent.retryGeneration(ctx, ids)),
  ).not.toBeNull();
  await t.finishAllScheduledFunctions(() => {});
  expect(classOf("retry")).toBe("durable");
});

test("a takeover from the app is plain, and the job it replaced writes nothing", async () => {
  const parked = gate();
  const go = gate();
  attempts.push(async (ctx, ids) => {
    parked.open();
    await go.opened;
    await run(ctx, "job", scripted(toolStep("j1")), ids.threadId, ids).catch(
      () => {},
    );
  });
  const { t, ids } = await submitted();
  const job = t.finishAllScheduledFunctions(() => {});
  await parked.opened;
  await t.action((ctx) =>
    run(
      ctx as ActionCtx,
      "takeover",
      scripted(toolStep("t1")),
      ids.threadId,
      ids,
    ),
  );
  go.open();
  await job;
  expect(classOf("takeover")).toBe("plain");
  expect(["none", "durable"]).toContain(classOf("job"));
  const orders = await t.run((ctx) => ctx.db.query("orders").collect());
  expect(orders.map((o) => o.item)).toEqual(["t1"]);
});

test("a continuation after an approval is durable, and runs the approved call as one", async () => {
  attempts.push((ctx, ids) =>
    run(
      ctx,
      "ask",
      scripted(toolStep("a1", "approvedPlace")),
      ids.threadId,
      ids,
    ),
  );
  attempts.push((ctx, ids) =>
    run(ctx, "continue", scripted("Done."), ids.threadId, ids),
  );
  const { t, ids, docs } = await submitted();
  await t.finishAllScheduledFunctions(() => {});
  const approvalId = (await docs())
    .flatMap((m): { type: string; approvalId?: string }[] =>
      Array.isArray(m.message?.content) ? m.message.content : [],
    )
    .find((p) => p.type === "tool-approval-request")!.approvalId!;
  await t.mutation((ctx) =>
    agent.approveToolCall(ctx, {
      threadId: ids.threadId,
      approvalId,
      generate,
    }),
  );
  await t.finishAllScheduledFunctions(() => {});
  await until(async () => (await docs()).at(-1)?.status === "success");
  expect(classOf("continue")).toBe("durable");
});

test("a custom startGeneration in the job is durable, and in the app is plain", async () => {
  attempts.push(async (ctx, ids) => {
    const { args } = await agent.start(
      watched(ctx, "custom"),
      { promptMessageId: ids.promptMessageId, model: scripted(toolStep("c1")) },
      { threadId: ids.threadId },
    );
    await streamText(args as never).consumeStream();
  });
  const { t, ids } = await submitted();
  await t.finishAllScheduledFunctions(() => {});
  expect(classOf("custom")).toBe("durable");
  await t.action(async (ctx) => {
    const { args } = await agent.start(
      watched(ctx as ActionCtx, "app"),
      { prompt: "Again.", model: scripted(toolStep("c2")) },
      { threadId: ids.threadId },
    );
    await streamText(args as never).consumeStream();
  });
  expect(classOf("app")).toBe("plain");
});

test("a plain generation after a durable turn in its thread is plain", async () => {
  attempts.push((ctx, ids) =>
    run(ctx, "durable", scripted(toolStep("d1")), ids.threadId, ids),
  );
  const { t, ids } = await submitted();
  await t.finishAllScheduledFunctions(() => {});
  await t.action((ctx) =>
    run(ctx as ActionCtx, "plain", scripted(toolStep("p1")), ids.threadId, {
      prompt: "Hello.",
    }),
  );
  expect(classOf("durable")).toBe("durable");
  expect(classOf("plain")).toBe("plain");
});

test("a plain generation at a saved prompt is plain", async () => {
  const t = createTest();
  const threadId = await t.mutation((ctx) =>
    createThread(ctx, components.agent, {}),
  );
  const { messageId } = await t.mutation((ctx) =>
    agent.saveMessage(ctx, { threadId, prompt: "Hello." }),
  );
  await t.action((ctx) =>
    run(ctx as ActionCtx, "plain", scripted(toolStep("p1")), threadId, {
      promptMessageId: messageId,
    }),
  );
  expect(classOf("plain")).toBe("plain");
});

void forever;
