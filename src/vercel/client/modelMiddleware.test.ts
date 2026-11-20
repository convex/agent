import { describe, expect, test } from "vitest";
import { stepCountIs, type LanguageModelMiddleware } from "ai";
import { v } from "convex/values";
import { z } from "zod/v4";
import {
  Agent,
  createThread,
  createTool,
  listMessages,
  ModelCallRefusedError,
  type ModelCallInfo,
} from "../index.js";
import { app, components } from "./setup.test.js";
import { mockModel } from "./mockModel.js";

type Event =
  | { kind: "reserve"; info: Omit<ModelCallInfo, "promptMessageId"> }
  | { kind: "settle"; stepNumber: number; text: string };

let events: Event[] = [];
// Refuse calls at these step numbers.
let refuseSteps = new Set<number>();
let usage: unknown[] = [];

function budgetMiddleware(_ctx: unknown, info: ModelCallInfo) {
  const reserve = () => {
    const { promptMessageId, ...rest } = info;
    expect(promptMessageId).toBeTypeOf("string");
    events.push({ kind: "reserve", info: rest });
    if (refuseSteps.has(info.stepNumber)) {
      throw new ModelCallRefusedError("Over budget", {
        data: { limit: "daily" },
      });
    }
  };
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      reserve();
      const result = await doGenerate();
      events.push({
        kind: "settle",
        stepNumber: info.stepNumber,
        text: result.content
          .map((c) => (c.type === "text" ? c.text : c.type))
          .join(""),
      });
      return result;
    },
    wrapStream: async ({ doStream }) => {
      reserve();
      return doStream();
    },
  } satisfies LanguageModelMiddleware;
}

const agent = new Agent(components.agent, {
  name: "middleware-test",
  instructions: "test",
  languageModel: mockModel({
    contentSteps: [
      [
        {
          type: "tool-call",
          toolCallId: "add-1",
          toolName: "add",
          input: JSON.stringify({ a: 1, b: 2 }),
        },
      ],
      [{ type: "text", text: "3" }],
    ],
  }),
  tools: {
    add: createTool({
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async (_ctx, { a, b }) => a + b,
    }),
  },
  stopWhen: stepCountIs(3),
  languageModelMiddleware: budgetMiddleware,
  usageHandler: async (_ctx, args) => {
    usage.push({
      promptMessageId: args.promptMessageId,
      order: args.order,
      stepOrder: args.stepOrder,
      stepNumber: args.stepNumber,
    });
  },
});

const run = app.action({
  args: {
    threadId: v.string(),
    refuse: v.array(v.number()),
    stream: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    events = [];
    usage = [];
    refuseSteps = new Set(args.refuse);
    try {
      if (args.stream) {
        const result = await agent.streamText(
          ctx,
          { threadId: args.threadId },
          { prompt: "add 1 and 2" },
          { saveStreamDeltas: true },
        );
        await result.consumeStream();
        await result.text;
      } else {
        await agent.generateText(
          ctx,
          { threadId: args.threadId },
          { prompt: "add 1 and 2" },
        );
      }
      return { events, usage, refused: null };
    } catch (error) {
      if (!ModelCallRefusedError.isInstance(error)) throw error;
      return { events, usage, refused: error.data };
    }
  },
});

const { api, createTest } = app.defineModules({ middleware: { run } });

async function threadMessages(
  t: ReturnType<typeof createTest>,
  threadId: string,
) {
  const { page } = await t.run((ctx) =>
    listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 50 },
    }),
  );
  return page
    .reverse()
    .map((m) => [m.stepOrder, m.message?.role, m.status, m.tool]);
}

describe("languageModelMiddleware", () => {
  test("runs per step with the call's user, thread, prompt and order", async () => {
    const t = createTest();
    const threadId = await t.run((ctx) =>
      createThread(ctx, components.agent, { userId: "u1" }),
    );
    const result = await t.action(api.middleware.run, {
      threadId,
      refuse: [],
    });
    const base = {
      userId: "u1",
      threadId,
      agentName: "middleware-test",
      order: 0,
    };
    expect(result.events).toEqual([
      { kind: "reserve", info: { ...base, stepNumber: 0 } },
      { kind: "settle", stepNumber: 0, text: "tool-call" },
      { kind: "reserve", info: { ...base, stepNumber: 1 } },
      { kind: "settle", stepNumber: 1, text: "3" },
    ]);
    expect(result.refused).toBeNull();
    const [first, second] = result.usage as {
      promptMessageId: string;
    }[];
    // A step is reported before it is saved, so it has no stepOrder yet.
    expect(first).toEqual({
      promptMessageId: first.promptMessageId,
      order: 0,
      stepOrder: undefined,
      stepNumber: 0,
    });
    expect(second).toEqual({
      promptMessageId: first.promptMessageId,
      order: 0,
      stepOrder: undefined,
      stepNumber: 1,
    });
  });

  test("a call refused at the first step throws and saves only the prompt", async () => {
    const t = createTest();
    const threadId = await t.run((ctx) =>
      createThread(ctx, components.agent, { userId: "u2" }),
    );
    const result = await t.action(api.middleware.run, {
      threadId,
      refuse: [0],
    });
    expect(result.refused).toEqual({ limit: "daily" });
    expect(result.usage).toEqual([]);
    expect(await threadMessages(t, threadId)).toEqual([
      [0, "user", "success", false],
    ]);
  });

  test("a call refused at a later step keeps the finished steps", async () => {
    const t = createTest();
    const threadId = await t.run((ctx) =>
      createThread(ctx, components.agent, { userId: "u3" }),
    );
    const result = await t.action(api.middleware.run, {
      threadId,
      refuse: [1],
    });
    expect(result.refused).toEqual({ limit: "daily" });
    expect(await threadMessages(t, threadId)).toEqual([
      [0, "user", "success", false],
      [1, "assistant", "success", true],
      [2, "tool", "success", true],
    ]);
  });

  test("streamText applies the middleware and a refusal saves nothing for the step", async () => {
    const t = createTest();
    const threadId = await t.run((ctx) =>
      createThread(ctx, components.agent, { userId: "u4" }),
    );
    const ok = await t.action(api.middleware.run, {
      threadId,
      refuse: [],
      stream: true,
    });
    // The shared mock model may start this stream at either of its steps.
    expect(ok.refused).toBeNull();
    expect(ok.events[0]).toMatchObject({
      kind: "reserve",
      info: { threadId, userId: "u4", stepNumber: 0 },
    });

    const refusedThread = await t.run((ctx) =>
      createThread(ctx, components.agent, { userId: "u5" }),
    );
    const refused = await t.action(api.middleware.run, {
      threadId: refusedThread,
      refuse: [0],
      stream: true,
    });
    expect(refused.refused).toEqual({ limit: "daily" });
    expect(await threadMessages(t, refusedThread)).toEqual([
      [0, "user", "success", false],
    ]);
  });
});
