import { afterEach, describe, expect, test, vi } from "vitest";
import { stepCountIs } from "ai";
import { v } from "convex/values";
import { z } from "zod/v4";
import {
  Agent,
  createThread,
  createTool,
  listMessages,
  saveMessage,
} from "../index.js";
import { app, components } from "./setup.test.js";
import { mockModel } from "./mockModel.js";

let rawEvents: Record<string, unknown>[] = [];
const agent = new Agent(components.agent, {
  name: "extras-test",
  instructions: "test",
  languageModel: mockModel({
    contentSteps: [
      [
        {
          type: "tool-call",
          toolCallId: "t-1",
          toolName: "noop",
          input: JSON.stringify({}),
        },
      ],
      [{ type: "text", text: "all done" }],
    ],
  }),
  tools: {
    noop: createTool({
      inputSchema: z.object({}),
      execute: async () => "ok",
    }),
  },
  stopWhen: stepCountIs(3),
  rawRequestResponseHandler: async (_ctx, args) => {
    const { request: _request, response: _response, ...rest } = args;
    rawEvents.push(rest);
  },
});

const generate = app.action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    rawEvents = [];
    const result = await agent.generateText(
      ctx,
      { threadId },
      { prompt: "go" },
    );
    return {
      rawEvents,
      promptMessageId: result.promptMessageId,
      saved: result.savedMessages!.map((m) => m._id),
    };
  },
});

const streamWithoutReading = app.action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const result = await agent.streamText(ctx, { threadId }, { prompt: "go" });
    // Nothing reads the stream. `saved` consumes it and waits for every step.
    await result.saved;
    const { page } = await listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 20 },
    });
    return page.map((m) => [m.stepOrder, m.message?.role, m.status]);
  },
});

const failingAgent = new Agent(components.agent, {
  name: "extras-failing",
  languageModel: mockModel({
    doStream: async () => {
      throw new Error("provider down");
    },
  }),
});

const streamFailure = app.action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const result = await failingAgent.streamText(
      ctx,
      { threadId },
      { prompt: "go" },
    );
    try {
      await result.saved;
      return "resolved";
    } catch (error) {
      return (error as Error).message;
    }
  },
});

let completed: string[] = [];
const onUserDeleted = app.mutation({
  args: { userId: v.string() },
  handler: async (_ctx, { userId }) => {
    completed.push(userId);
  },
});

const { api, createTest } = app.defineModules({
  extras: { generate, streamWithoutReading, streamFailure, onUserDeleted },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rawRequestResponseHandler", () => {
  test("gets the prompt, order, stepOrder, step, saved message ids and duration", async () => {
    const t = createTest();
    const threadId = await t.run((ctx) =>
      createThread(ctx, components.agent, { userId: "raw" }),
    );
    const { rawEvents, promptMessageId, saved } = await t.action(
      api.extras.generate,
      { threadId },
    );
    expect(rawEvents).toHaveLength(2);
    for (const event of rawEvents) {
      expect(event.durationMs).toBeTypeOf("number");
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(rawEvents.map(({ durationMs: _d, ...rest }) => rest)).toEqual([
      {
        userId: "raw",
        threadId,
        agentName: "extras-test",
        promptMessageId,
        order: 0,
        stepOrder: 2,
        stepNumber: 0,
        savedMessageIds: [saved[1], saved[2]],
      },
      {
        userId: "raw",
        threadId,
        agentName: "extras-test",
        promptMessageId,
        order: 0,
        stepOrder: 3,
        stepNumber: 1,
        savedMessageIds: [saved[3]],
      },
    ]);
  });
});

describe("streamText saved", () => {
  test("resolves after every step is saved, without reading the stream", async () => {
    const t = createTest();
    const threadId = await t.run((ctx) =>
      createThread(ctx, components.agent, {}),
    );
    const rows = await t.action(api.extras.streamWithoutReading, { threadId });
    expect(rows.reverse()).toEqual([
      [0, "user", "success"],
      [1, "assistant", "success"],
      [2, "tool", "success"],
      [3, "assistant", "success"],
    ]);
  });

  test("rejects when the generation fails", async () => {
    const t = createTest();
    const threadId = await t.run((ctx) =>
      createThread(ctx, components.agent, {}),
    );
    expect(await t.action(api.extras.streamFailure, { threadId })).toMatch(
      /provider down/,
    );
  });
});

describe("deleteAllForUser", () => {
  test("deletes the user's threads and then calls onComplete", async () => {
    vi.useFakeTimers();
    completed = [];
    const t = createTest();
    const threadIds = await t.run(async (ctx) => {
      const ids = [];
      for (let i = 0; i < 2; i++) {
        const threadId = await createThread(ctx, components.agent, {
          userId: "leaving",
        });
        await saveMessage(ctx, components.agent, { threadId, prompt: "hi" });
        ids.push(threadId);
      }
      return ids;
    });
    const isDone = await t.run((ctx) =>
      agent.deleteAllForUser(ctx, {
        userId: "leaving",
        onComplete: api.extras.onUserDeleted,
      }),
    );
    expect(isDone).toBe(false);
    expect(completed).toEqual([]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(completed).toEqual(["leaving"]);
    for (const threadId of threadIds) {
      expect(
        await t.run((ctx) =>
          ctx.runQuery(components.agent.threads.getThread, { threadId }),
        ),
      ).toBeNull();
    }
  });

  test("calls onComplete when the user has nothing to delete", async () => {
    vi.useFakeTimers();
    completed = [];
    const t = createTest();
    expect(
      await t.run((ctx) =>
        agent.deleteAllForUser(ctx, {
          userId: "nobody",
          onComplete: api.extras.onUserDeleted,
        }),
      ),
    ).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(completed).toEqual(["nobody"]);
  });
});
