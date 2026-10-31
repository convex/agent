import { afterEach, describe, expect, test, vi } from "vitest";
import { v } from "convex/values";
import { stepCountIs } from "ai";
import { z } from "zod/v4";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { ActionCtx } from "./types.js";
import type { MessageDoc } from "../../validators.js";
import { Agent, AlreadyClaimedError, createTool } from "../index.js";
import { app, components } from "./setup.test.js";
import { mockModel } from "./mockModel.js";

afterEach(() => vi.useRealTimers());

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const TOOL_CALL: LanguageModelV4GenerateResult = {
  content: [
    {
      type: "tool-call",
      toolCallId: "tc-lookup",
      toolName: "lookup",
      input: "{}",
    },
  ],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage: USAGE,
  warnings: [],
};
const ANSWER: LanguageModelV4GenerateResult = {
  content: [{ type: "text", text: "Looked it up" }],
  finishReason: { unified: "stop", raw: undefined },
  usage: USAGE,
  warnings: [],
};

// Counts across actions, as a paid provider and a side-effecting tool would.
let modelCalls = 0;
let toolRuns = 0;
let failNextAnswer = false;
const lookup = createTool({
  description: "Look it up",
  inputSchema: z.object({}),
  execute: async () => {
    toolRuns++;
    return "found";
  },
});
const agent = new Agent(components.agent, {
  name: "claims",
  languageModel: mockModel({
    doGenerate: async (options) => {
      modelCalls++;
      const sawToolResult = options.prompt.some((m) => m.role === "tool");
      if (!sawToolResult) return TOOL_CALL;
      if (failNextAnswer) {
        failNextAnswer = false;
        throw new Error("provider failed");
      }
      return ANSWER;
    },
  }),
  tools: { lookup },
  stopWhen: stepCountIs(3),
});

const queue = app.action({
  args: {},
  handler: async (ctx) => {
    const { threadId } = await agent.createThread(ctx, {});
    const { messageId: promptMessageId } = await agent.saveMessage(ctx, {
      threadId,
      prompt: "Look it up",
    });
    const { messageId: pendingMessageId } = await agent.saveMessage(ctx, {
      threadId,
      promptMessageId,
      message: { role: "assistant", content: [] },
      metadata: { status: "pending" },
    });
    return { threadId, pendingMessageId };
  },
});

// What a workflow step, a webhook handler or a poll would run.
const answer = app.action({
  args: {
    threadId: v.string(),
    pendingMessageId: v.string(),
    approvals: v.optional(v.boolean()),
    stopConditionThrows: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { threadId, pendingMessageId, approvals, stopConditionThrows },
  ) => {
    try {
      const result = await (approvals ? approvalAgent : agent).generateText(
        ctx,
        { threadId },
        {
          pendingMessageId,
          ...(stopConditionThrows && {
            stopWhen: () => {
              throw new Error("stop condition failed");
            },
          }),
        },
      );
      return result.text;
    } catch (error) {
      if (error instanceof AlreadyClaimedError) return error.status;
      throw error;
    }
  },
});

const sawResult = (
  prompt: { role: string; content: unknown }[],
  toolName: string,
) =>
  prompt.some(
    (m) =>
      m.role === "tool" &&
      (m.content as { type: string; toolName?: string }[]).some(
        (part) => part.type === "tool-result" && part.toolName === toolName,
      ),
  );
const toolCall = (toolName: string): LanguageModelV4GenerateResult => ({
  ...TOOL_CALL,
  content: [
    {
      type: "tool-call",
      toolCallId: `tc-${toolName}`,
      toolName,
      input: "{}",
    },
  ],
});
// Asks to remove (which needs approval), then looks up, then answers.
const approvalAgent = new Agent(components.agent, {
  name: "claims-approval",
  languageModel: mockModel({
    doGenerate: async ({ prompt }) => {
      modelCalls++;
      if (!sawResult(prompt, "remove")) return toolCall("remove");
      if (!sawResult(prompt, "lookup")) return toolCall("lookup");
      if (failNextAnswer) {
        failNextAnswer = false;
        throw new Error("provider failed");
      }
      return ANSWER;
    },
  }),
  tools: {
    lookup,
    remove: createTool({
      description: "Remove it",
      inputSchema: z.object({}),
      needsApproval: () => true,
      execute: async () => {
        toolRuns++;
        return "removed";
      },
    }),
  },
  stopWhen: stepCountIs(3),
});

// Asks for approval, approves, and queues the continuation's answer.
const queueApproved = app.action({
  args: {},
  handler: async (ctx) => {
    const { threadId } = await approvalAgent.createThread(ctx, {});
    const { savedMessages } = await approvalAgent.generateText(
      ctx,
      { threadId },
      { prompt: "Remove it" },
    );
    const approvalId = savedMessages!
      .flatMap((m) =>
        Array.isArray(m.message?.content) ? m.message.content : [],
      )
      .flatMap((part) =>
        part.type === "tool-approval-request" ? [part.approvalId] : [],
      )[0]!;
    const { messageId: promptMessageId } = await ctx.runMutation(
      components.agent.messages.respondToToolCallApprovals,
      {
        threadId,
        agentName: "claims-approval",
        decisions: [{ approvalId, approved: true }],
      },
    );
    const { messageId: pendingMessageId } = await approvalAgent.saveMessage(
      ctx,
      {
        threadId,
        promptMessageId,
        message: { role: "assistant", content: [] },
        metadata: { status: "pending" },
      },
    );
    return { threadId, pendingMessageId };
  },
});

// Claims a queued answer and streams a whole tool step, then stops as if the
// action died before saving the step.
const lapse = app.action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ threadId: string; pendingMessageId: string }> => {
    const queued: { threadId: string; pendingMessageId: string } =
      await ctx.runAction(api.claims.test.queue, {});
    const { threadId, pendingMessageId } = queued;
    const claim = await ctx.runMutation(
      components.agent.messages.claimPendingMessage,
      { threadId, messageId: pendingMessageId },
    );
    if (claim.status !== "claimed") throw new Error(claim.status);
    const streamId = await ctx.runMutation(components.agent.streams.create, {
      threadId,
      order: claim.message.order,
      stepOrder: claim.message.stepOrder,
      format: "UIMessageChunk",
      pendingMessageId,
    });
    await ctx.runMutation(components.agent.streams.addDelta, {
      streamId,
      start: 0,
      end: 4,
      parts: [
        { type: "start-step" },
        {
          type: "tool-input-available",
          toolCallId: "tc-lookup",
          toolName: "lookup",
          input: {},
        },
        {
          type: "tool-output-available",
          toolCallId: "tc-lookup",
          output: "found",
        },
        { type: "finish-step" },
      ],
    });
    return queued;
  },
});

async function readThread(ctx: ActionCtx, threadId: string) {
  const { page } = await ctx.runQuery(
    components.agent.messages.listMessagesByThreadId,
    {
      threadId,
      order: "asc",
      statuses: ["pending", "success", "failed"],
      paginationOpts: { cursor: null, numItems: 50 },
    },
  );
  return (page as MessageDoc[]).map((m) => ({
    _id: m._id,
    role: m.message?.role,
    status: m.status,
    text: m.text,
    error: m.error,
  }));
}
const read = app.action({
  args: { threadId: v.string() },
  handler: (ctx, { threadId }) => readThread(ctx, threadId),
});

// Delays creating the stream row, which writing deltas waits on.
const streamWithSlowStreamCreation = app.action({
  args: { threadId: v.string(), pendingMessageId: v.string() },
  handler: async (ctx, { threadId, pendingMessageId }) => {
    const stepSaveStreamIds: (string | undefined)[] = [];
    const slow = {
      ...ctx,
      runMutation: (async (reference, args) => {
        if (reference === components.agent.streams.create) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const save = args as {
          pendingMessageId?: string;
          streamId?: string;
          messages?: MessageDoc[];
        };
        if (save.pendingMessageId && save.messages?.at(-1)?.status) {
          stepSaveStreamIds.push(save.streamId);
        }
        return ctx.runMutation(reference, args);
      }) as ActionCtx["runMutation"],
    };
    const result = await agent.streamText(
      slow,
      { threadId },
      {
        pendingMessageId,
        model: mockModel({
          contentSteps: [
            [
              {
                type: "tool-call",
                toolCallId: "tc-lookup",
                toolName: "lookup",
                input: "{}",
              },
            ],
            [{ type: "text", text: "Looked it up" }],
          ],
        }),
      },
      { saveStreamDeltas: { throttleMs: 0, returnImmediately: true } },
    );
    await result.consumeStream();
    // Let the background stream consumer finish.
    await new Promise((resolve) => setTimeout(resolve, 300));
    return stepSaveStreamIds;
  },
});

const { api, createTest } = app.defineModules({
  "claims/test": {
    queue,
    answer,
    read,
    streamWithSlowStreamCreation,
    queueApproved,
    lapse,
  },
});

function reset() {
  modelCalls = 0;
  toolRuns = 0;
  failNextAnswer = false;
}

describe("generating into an existing pending message", () => {
  test("answers in the placeholder instead of failing it as Restarting", async () => {
    reset();
    const t = createTest();
    const { threadId, pendingMessageId } = await t.action(
      api.claims.test.queue,
      {},
    );
    expect(await t.action(api.claims.test.read, { threadId })).toEqual([
      expect.objectContaining({ role: "user", status: "success" }),
      expect.objectContaining({
        _id: pendingMessageId,
        role: "assistant",
        status: "pending",
      }),
    ]);

    expect(
      await t.action(api.claims.test.answer, { threadId, pendingMessageId }),
    ).toBe("Looked it up");

    const thread = await t.action(api.claims.test.read, { threadId });
    expect(thread.map(({ role, status }) => [role, status])).toEqual([
      ["user", "success"],
      ["assistant", "success"],
      ["tool", "success"],
      ["assistant", "success"],
    ]);
    expect(thread[1]._id).toBe(pendingMessageId);
    expect(thread.some((m) => m.error === "Restarting")).toBe(false);
  });
});

describe("answering once (workflow retries, duplicate webhooks)", () => {
  test("a retried action saves one answer and runs tools once", async () => {
    reset();
    const t = createTest();
    const { threadId, pendingMessageId } = await t.action(
      api.claims.test.queue,
      {},
    );
    expect(
      await t.action(api.claims.test.answer, { threadId, pendingMessageId }),
    ).toBe("Looked it up");

    // The workflow retries the step, e.g. because the action's result was
    // lost after the answer was saved.
    expect(
      await t.action(api.claims.test.answer, { threadId, pendingMessageId }),
    ).toBe("answered");

    expect(modelCalls).toBe(2);
    expect(toolRuns).toBe(1);
    const thread = await t.action(api.claims.test.read, { threadId });
    expect(thread.map(({ role, status }) => [role, status])).toEqual([
      ["user", "success"],
      ["assistant", "success"],
      ["tool", "success"],
      ["assistant", "success"],
    ]);
  });

  test("overlapping attempts generate once", async () => {
    reset();
    const t = createTest();
    const { threadId, pendingMessageId } = await t.action(
      api.claims.test.queue,
      {},
    );

    const results = await Promise.all([
      t.action(api.claims.test.answer, { threadId, pendingMessageId }),
      t.action(api.claims.test.answer, { threadId, pendingMessageId }),
    ]);

    expect(results.sort()).toEqual(["Looked it up", "running"]);
    expect(modelCalls).toBe(2);
    expect(toolRuns).toBe(1);
  });

  test("a retry after a failure resumes without rerunning saved tools", async () => {
    reset();
    const t = createTest();
    const { threadId, pendingMessageId } = await t.action(
      api.claims.test.queue,
      {},
    );
    failNextAnswer = true;
    await expect(
      t.action(api.claims.test.answer, { threadId, pendingMessageId }),
    ).rejects.toThrow("provider failed");
    expect(
      (await t.action(api.claims.test.read, { threadId })).map(
        ({ role, status }) => [role, status],
      ),
    ).toEqual([
      ["user", "success"],
      ["assistant", "success"],
      ["tool", "success"],
      ["assistant", "failed"],
    ]);

    expect(
      await t.action(api.claims.test.answer, { threadId, pendingMessageId }),
    ).toBe("Looked it up");

    expect(toolRuns).toBe(1);
    // The tool call, the failed answer, and the retried answer.
    expect(modelCalls).toBe(3);
    const thread = await t.action(api.claims.test.read, { threadId });
    expect(thread.map(({ role, status }) => [role, status])).toEqual([
      ["user", "success"],
      ["assistant", "success"],
      ["tool", "success"],
      ["assistant", "failed"],
      ["assistant", "success"],
    ]);
    expect(thread.at(-1)?.text).toBe("Looked it up");
    expect(
      await t.action(api.claims.test.answer, { threadId, pendingMessageId }),
    ).toBe("answered");
  });
});

describe("the claim, not the messages, says whether it was answered", () => {
  test("a saved tool step doesn't answer a generation that then failed", async () => {
    reset();
    const t = createTest();
    const { threadId, pendingMessageId } = await t.action(
      api.claims.test.queue,
      {},
    );
    await expect(
      t.action(api.claims.test.answer, {
        threadId,
        pendingMessageId,
        stopConditionThrows: true,
      }),
    ).rejects.toThrow("stop condition failed");

    expect(
      await t.action(api.claims.test.answer, { threadId, pendingMessageId }),
    ).toBe("Looked it up");
    expect(toolRuns).toBe(1);
    expect(
      await t.action(api.claims.test.answer, { threadId, pendingMessageId }),
    ).toBe("answered");
  });

  test("a takeover continues from a lapsed attempt's streamed tool step without rerunning it", async () => {
    reset();
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = createTest();
    const { threadId, pendingMessageId } = await t.action(
      api.claims.test.lapse,
      {},
    );
    expect(
      await t.action(api.claims.test.answer, { threadId, pendingMessageId }),
    ).toBe("running");

    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(
      await t.action(api.claims.test.answer, { threadId, pendingMessageId }),
    ).toBe("Looked it up");

    expect(toolRuns).toBe(0);
    expect(modelCalls).toBe(1);
    const thread = await t.action(api.claims.test.read, { threadId });
    expect(thread.map(({ role, status }) => [role, status])).toEqual([
      ["user", "success"],
      ["assistant", "success"],
      ["tool", "success"],
      ["assistant", "success"],
    ]);
    expect(
      await t.action(api.claims.test.answer, { threadId, pendingMessageId }),
    ).toBe("answered");
  });

  test("a failed approval continuation can be retried after its answer became a tool message", async () => {
    reset();
    const t = createTest();
    const { threadId, pendingMessageId } = await t.action(
      api.claims.test.queueApproved,
      {},
    );
    failNextAnswer = true;
    await expect(
      t.action(api.claims.test.answer, {
        threadId,
        pendingMessageId,
        approvals: true,
      }),
    ).rejects.toThrow("provider failed");
    expect(
      (await t.action(api.claims.test.read, { threadId })).find(
        (m) => m._id === pendingMessageId,
      )?.role,
    ).toBe("tool");

    expect(
      await t.action(api.claims.test.answer, {
        threadId,
        pendingMessageId,
        approvals: true,
      }),
    ).toBe("Looked it up");
    expect(toolRuns).toBe(2);
  });
});

describe("a stream follows the pending message it saves into", () => {
  test("each step save passes the stream, even if creating it is slow", async () => {
    reset();
    const t = createTest();
    const { threadId, pendingMessageId } = await t.action(
      api.claims.test.queue,
      {},
    );

    const streamIds = await t.action(
      api.claims.test.streamWithSlowStreamCreation,
      { threadId, pendingMessageId },
    );

    expect(streamIds).toHaveLength(1);
    expect(streamIds[0]).toEqual(expect.any(String));
  });
});
