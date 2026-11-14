import { describe, expect, it, test } from "vitest";
import { z } from "zod";
import { stepCountIs } from "ai";
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
