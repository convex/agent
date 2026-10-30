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
  args: { threadId: v.string(), pendingMessageId: v.string() },
  handler: async (ctx, { threadId, pendingMessageId }) => {
    try {
      const result = await agent.generateText(
        ctx,
        { threadId },
        { pendingMessageId },
      );
      return result.text;
    } catch (error) {
      if (error instanceof AlreadyClaimedError) return error.status;
      throw error;
    }
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

const { api, createTest } = app.defineModules({
  "claims/test": { queue, answer, read },
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
