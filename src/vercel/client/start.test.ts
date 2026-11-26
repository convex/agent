import { describe, expect, it, test } from "vitest";
import { z } from "zod";
import { generateText, stepCountIs } from "ai";
import { MockEmbeddingModelV4 } from "ai/test";
import { getFunctionAddress } from "convex/server";
import { resolveUsageModel } from "./start.js";
import { Agent, createThread, createTool } from "../index.js";
import { components, initConvexTest } from "./setup.test.js";
import { mockModel } from "./mockModel.js";
import type { ActionCtx, Config } from "./types.js";

describe("resolveUsageModel", () => {
  it("prefers a step model while object results retain the active model", () => {
    const activeModel = { provider: "fallback", model: "fallback-model" };
    const stepModel = { provider: "router", model: "routed-model" };

    expect(resolveUsageModel({ step: { model: stepModel } }, activeModel)).toBe(
      stepModel,
    );
    expect(resolveUsageModel({ object: {} }, activeModel)).toBe(activeModel);
  });
});

function recordCalls(ctx: ActionCtx) {
  const calls: string[] = [];
  const record = <F extends (ref: never, args: never) => Promise<unknown>>(
    kind: string,
    run: F,
  ) =>
    ((ref: never, args: never) => {
      const { reference } = getFunctionAddress(ref) as { reference: string };
      const name = `${kind} ${reference.split("/").slice(-2).join(":")}`;
      if (calls.at(-1) !== name || !name.endsWith("addDelta")) calls.push(name);
      return run(ref, args);
    }) as F;
  return {
    calls,
    ctx: {
      ...ctx,
      runQuery: record("query", ctx.runQuery),
      runMutation: record("mutation", ctx.runMutation),
      runAction: record("action", ctx.runAction),
    },
  };
}

// Runs a tool step and an answer step on a thread owned by "u1", without
// passing its userId, and reports the userId each consumer saw.
async function generate(options: {
  config?: Partial<Config>;
  saveMessages?: "none";
  stream?: boolean;
}) {
  const seen: Record<string, (string | undefined)[]> = {};
  const see = (who: string, userId: string | undefined) => {
    (seen[who] ??= []).push(userId);
  };
  const whoAmI = createTool({
    description: "whoAmI",
    inputSchema: z.object({}),
    execute: async (ctx) => {
      see("tool", ctx.userId);
      return "ok";
    },
  });
  const agent = new Agent(components.agent, {
    name: "user-id",
    languageModel: mockModel({
      contentSteps: [
        [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "whoAmI",
            input: "{}",
          },
        ],
        [{ type: "text", text: "done" }],
      ],
    }),
    tools: { whoAmI },
    stopWhen: stepCountIs(2),
    usageHandler: async (_ctx, { userId }) => see("usage", userId),
    rawRequestResponseHandler: async (_ctx, { userId }) =>
      see("rawRequestResponse", userId),
    embeddingModel: options.config?.embeddingModel,
    contextHandler:
      options.config?.contextHandler &&
      (async (ctx, args) => {
        see("context", args.userId);
        return options.config!.contextHandler!(ctx, args);
      }),
  });
  const t = initConvexTest();
  return t.action(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, {
      userId: "u1",
    });
    const recorded = recordCalls(ctx);
    const storageOptions = options.saveMessages
      ? { saveMessages: options.saveMessages }
      : undefined;
    if (options.stream) {
      const result = await agent.streamText(
        recorded.ctx,
        { threadId },
        { prompt: "hi" },
        { saveStreamDeltas: { throttleMs: 0 }, storageOptions },
      );
      await result.consumeStream();
    } else {
      await agent.generateText(
        recorded.ctx,
        { threadId },
        { prompt: "hi" },
        { storageOptions },
      );
    }
    const { page } = await ctx.runQuery(
      components.agent.messages.listMessagesByThreadId,
      { threadId, order: "asc" },
    );
    const streams = await ctx.runQuery(components.agent.streams.list, {
      threadId,
      statuses: ["streaming", "finished", "aborted"],
    });
    return {
      calls: recorded.calls,
      seen,
      messageUserIds: page.map((m) => m.userId),
      streamUserIds: streams.map((s) => s.userId),
    };
  });
}

describe("a generation takes its userId from the thread it saves to", () => {
  test("generateText gets it back from its first save", async () => {
    const r = await generate({});
    expect(r.calls).toEqual([
      "query messages:listMessagesByThreadId",
      "mutation messages:addMessages",
      "mutation messages:addMessages",
      "mutation messages:addMessages",
    ]);
    expect(r.seen).toEqual({
      tool: ["u1"],
      usage: ["u1", "u1"],
      rawRequestResponse: ["u1", "u1"],
    });
    expect(r.messageUserIds).toEqual(["u1", "u1", "u1", "u1"]);
  });

  test("streamText gets it back from its first save", async () => {
    const r = await generate({ stream: true });
    expect(r.calls.slice(0, 3)).toEqual([
      "query messages:listMessagesByThreadId",
      "mutation messages:addMessages",
      "mutation streams:create",
    ]);
    expect(r.calls).not.toContain("query threads:getThread");
    expect(r.seen.tool).toEqual(["u1"]);
    expect(new Set(r.messageUserIds)).toEqual(new Set(["u1"]));
    expect(r.streamUserIds).toEqual(["u1"]);
  });

  test("a context handler gets it before anything is saved", async () => {
    const r = await generate({
      config: { contextHandler: async (_ctx, { allMessages }) => allMessages },
    });
    expect(r.calls[0]).toBe("query threads:getThread");
    expect(r.seen.context).toEqual(["u1"]);
    expect(r.seen.tool).toEqual(["u1"]);
  });

  test("embedding usage gets it before anything is saved", async () => {
    const r = await generate({
      config: {
        embeddingModel: new MockEmbeddingModelV4({
          doEmbed: async ({ values }) => ({
            embeddings: values.map(() => Array(128).fill(0.1)),
            usage: { tokens: 1 },
            warnings: [],
          }),
        }),
      },
    });
    expect(r.calls[0]).toBe("query threads:getThread");
    expect(new Set(r.seen.usage)).toEqual(new Set(["u1"]));
    expect(r.seen.usage!.length).toBeGreaterThan(2);
  });

  test("without saved messages it is read from the thread", async () => {
    const r = await generate({ saveMessages: "none" });
    expect(r.calls).toEqual([
      "query threads:getThread",
      "query messages:listMessagesByThreadId",
    ]);
    expect(r.seen).toEqual({
      tool: ["u1"],
      usage: ["u1", "u1"],
      rawRequestResponse: ["u1", "u1"],
    });
  });
});

test("usage and raw request handlers get the prompt message id", async () => {
  const seen: Record<string, string | undefined> = {};
  const agent = new Agent(components.agent, {
    name: "prompt-id",
    languageModel: mockModel({ content: [{ type: "text", text: "done" }] }),
    usageHandler: async (_ctx, { promptMessageId }) => {
      seen.usage = promptMessageId;
    },
    rawRequestResponseHandler: async (_ctx, { promptMessageId }) => {
      seen.rawRequestResponse = promptMessageId;
    },
  });
  const promptMessageId = await initConvexTest().action(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, {});
    return (await agent.generateText(ctx, { threadId }, { prompt: "hi" }))
      .promptMessageId;
  });
  expect(promptMessageId).toBeDefined();
  expect(seen).toEqual({
    usage: promptMessageId,
    rawRequestResponse: promptMessageId,
  });
});

test("tools get the prompt message id", async () => {
  const seen: (string | undefined)[] = [];
  const agent = new Agent(components.agent, {
    name: "prompt-id",
    languageModel: mockModel({
      contentSteps: [
        [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "promptId",
            input: "{}",
          },
        ],
        [{ type: "text", text: "done" }],
      ],
    }),
    tools: {
      promptId: createTool({
        description: "promptId",
        inputSchema: z.object({}),
        execute: async (ctx) => {
          seen.push(ctx.promptMessageId);
          return "ok";
        },
      }),
    },
    stopWhen: stepCountIs(2),
  });
  const promptMessageId = await initConvexTest().action(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, {});
    return (await agent.generateText(ctx, { threadId }, { prompt: "hi" }))
      .promptMessageId;
  });
  expect(promptMessageId).toBeDefined();
  expect(seen).toEqual([promptMessageId]);
});

async function threadRows(ctx: ActionCtx, threadId: string) {
  const { page } = await ctx.runQuery(
    components.agent.messages.listMessagesByThreadId,
    { threadId, order: "asc" },
  );
  return page.map((m) => [m.message?.role, m.status, m.error ?? null]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("agent.start", () => {
  test("an abort while a save commits fails the pending message it made", async () => {
    const agent = new Agent(components.agent, {
      name: "start",
      languageModel: mockModel({ content: [{ type: "text", text: "done" }] }),
    });
    const rows = await initConvexTest().action(async (ctx) => {
      const threadId = await createThread(ctx, components.agent, {});
      const abort = new AbortController();
      const intercepted: ActionCtx = {
        ...ctx,
        runMutation: (async (reference, mutationArgs) => {
          const result = await ctx.runMutation(reference, mutationArgs);
          // The step save has committed; its reply hasn't arrived.
          if (
            (mutationArgs as { pendingMessageId?: string }).pendingMessageId
          ) {
            abort.abort("Stopped");
            await sleep(50);
          }
          return result;
        }) as ActionCtx["runMutation"],
      };
      const { args, save } = await agent.start(
        intercepted,
        { prompt: "hi", abortSignal: abort.signal },
        { threadId },
      );
      const result = await generateText(args);
      await save({ step: result.steps[0] }, true);
      await sleep(50);
      return threadRows(ctx, threadId);
    });
    expect(rows).toEqual([
      ["user", "success", null],
      ["assistant", "success", null],
      ["assistant", "failed", "Stopped"],
    ]);
  });
});

test("a missing model throws before the prompt is saved", async () => {
  const agent = new Agent(components.agent, {
    name: "no-model",
    // Required by the type, but can be missing at runtime.
    languageModel: undefined as never,
  });
  const { error, rows } = await initConvexTest().action(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, {});
    const error = await agent
      .generateText(ctx, { threadId }, { prompt: "hi" })
      .then(
        () => null,
        (e: Error) => e.message,
      );
    return { error, rows: await threadRows(ctx, threadId) };
  });
  expect(error).toContain("model is required");
  expect(rows).toEqual([]);
});

test("the agent's prepareStep gets the ctx its tools get, and a call's prepareStep replaces it", async () => {
  const seen: unknown[] = [];
  const agent: Agent<{ orgId: string }> = new Agent(components.agent, {
    name: "prepare",
    languageModel: mockModel({ content: [{ type: "text", text: "ok" }] }),
    prepareStep: async (ctx, step) => {
      seen.push({
        orgId: ctx.orgId,
        threadId: ctx.threadId,
        userId: ctx.userId,
        promptMessageId: ctx.promptMessageId,
        agent: ctx.agent === agent,
        stepNumber: step.stepNumber,
      });
      return undefined;
    },
  });
  const turns = await initConvexTest().action(async (actionCtx) => {
    const ctx = { ...actionCtx, orgId: "o1" };
    const threadId = await createThread(ctx, components.agent, {
      userId: "u1",
    });
    const generated = await agent.generateText(
      ctx,
      { threadId },
      { prompt: "hello" },
    );
    const streamed = await agent.streamText(
      ctx,
      { threadId },
      { prompt: "again" },
    );
    await streamed.consumeStream();
    await agent.generateText(
      ctx,
      { threadId },
      { prompt: "replaced", prepareStep: () => undefined },
    );
    return [generated, streamed].map(({ promptMessageId }) => ({
      orgId: "o1",
      threadId,
      userId: "u1",
      promptMessageId,
      agent: true,
      stepNumber: 0,
    }));
  });
  expect(seen).toEqual(turns);
});
