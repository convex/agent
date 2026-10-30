/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  Experimental_BatchV4 as BatchApi,
  Experimental_BatchV4ItemResult as BatchItemResult,
  Experimental_TextBatchV4Request as TextBatchV4Request,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import {
  Agent,
  createTool,
  mockModel,
  stepCountIs,
  type MessageDoc,
  type UsageHandler,
} from "@convex-dev/agent";
import agentTest from "@convex-dev/agent/test";
import { defineTestApp } from "convex-test";
import { v } from "convex/values";
import { z } from "zod/v4";
import schema from "../schema.js";
import * as batchModule from "./batch.js";
import { saveBatchResults, startThreadBatch } from "./batch.js";

const app = defineTestApp({ schema, components: { agent: agentTest } });

afterEach(() => vi.useRealTimers());

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const PROVIDER = "mock-provider";
const MODEL_ID = "mock-model-id";

function generated(
  content: LanguageModelV4Content[],
  finishReason: "stop" | "tool-calls" = "stop",
): LanguageModelV4GenerateResult {
  return {
    content,
    finishReason: { unified: finishReason, raw: finishReason },
    usage: USAGE,
    warnings: [],
  };
}

const ANSWER: LanguageModelV4Content[] = [
  { type: "reasoning", text: "Thinking about A" },
  { type: "text", text: "Answer for A" },
];

const usageCalls: Parameters<UsageHandler>[1][] = [];
const usageHandler: UsageHandler = async (_ctx, args) => {
  usageCalls.push(args);
};

const weather = createTool({
  description: "Get the weather",
  inputSchema: z.object({ city: z.string() }),
  execute: async (_ctx, { city }) => `Sunny in ${city}`,
});

// The model only serves the steps after a batch result, i.e. the follow-up
// generation once a batched tool call has run.
const continuationModel = mockModel({
  provider: PROVIDER,
  modelId: MODEL_ID,
  content: [{ type: "text", text: "It is sunny in Paris." }],
});
const agent = new Agent(app.components.agent, {
  name: "Batch Agent",
  instructions: "You are a concise assistant.",
  languageModel: continuationModel,
  tools: { weather },
  stopWhen: stepCountIs(3),
  usageHandler,
});

type MockBatch = {
  requests: TextBatchV4Request[];
  status: "pending" | "completed";
  results: BatchItemResult[];
};
const batches = new Map<string, MockBatch>();

const batchApi: BatchApi = {
  specificationVersion: "v4",
  provider: PROVIDER,
  supportedUrls: {},
  async doStartBatch({ requests }) {
    const batchId = `batch-${batches.size}`;
    batches.set(batchId, {
      requests: requests as TextBatchV4Request[],
      status: "pending",
      results: [],
    });
    return { batchId, status: "pending", warnings: [] };
  },
  async doGetBatchStatus({ batchId }) {
    return { status: batches.get(batchId)!.status };
  },
  async doGetBatchResults({ batchId }) {
    const results = batches.get(batchId)!.results;
    return new ReadableStream<BatchItemResult>({
      start(controller) {
        for (const result of results) controller.enqueue(result);
        controller.close();
      },
    });
  },
};

function completeBatch(
  batchId: string,
  results: (request: TextBatchV4Request) => BatchItemResult | undefined,
) {
  const batch = batches.get(batchId)!;
  batch.status = "completed";
  batch.results = batch.requests.flatMap((r) => results(r) ?? []);
}

const setup = app.action({
  args: {},
  handler: async (ctx) => {
    const threads: { threadId: string; promptMessageId: string }[] = [];
    for (const prompt of [
      "Question A",
      "Weather in Paris?",
      "Question C",
      "Question D",
    ]) {
      const { threadId } = await agent.createThread(ctx, { userId: "user" });
      const { messageId } = await agent.saveMessage(ctx, { threadId, prompt });
      threads.push({ threadId, promptMessageId: messageId });
    }
    return threads;
  },
});

const start = app.action({
  args: {
    items: v.array(
      v.object({ threadId: v.string(), promptMessageId: v.string() }),
    ),
  },
  handler: async (ctx, { items }) =>
    startThreadBatch(ctx, agent, batchApi, items),
});

const save = app.action({
  args: { batchId: v.id("batches") },
  handler: async (ctx, { batchId }) =>
    saveBatchResults(ctx, agent, batchApi, batchId),
});

const sendMessage = app.mutation({
  args: { threadId: v.string(), prompt: v.string() },
  handler: async (ctx, { threadId, prompt }) => {
    await agent.saveMessage(ctx, { threadId, prompt, skipEmbeddings: true });
  },
});

const generateNormally = app.action({
  args: { prompt: v.string() },
  handler: async (ctx, { prompt }) => {
    const { threadId } = await agent.createThread(ctx, { userId: "user" });
    await agent.generateText(
      ctx,
      { threadId },
      {
        prompt,
        model: mockModel({
          provider: PROVIDER,
          modelId: MODEL_ID,
          content: ANSWER,
        }),
      },
    );
    return threadId;
  },
});

const list = app.query({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) =>
    (
      await agent.listMessages(ctx, {
        threadId,
        statuses: ["pending", "success", "failed"],
        paginationOpts: { numItems: 50, cursor: null },
      })
    ).page.reverse(),
});

// A poll that claims a result and then dies (e.g. the action hits its time
// limit) before saving it.
let claimed: () => void = () => {};
const crashWhileSaving = app.action({
  args: { threadId: v.string(), pendingMessageId: v.string() },
  handler: async (ctx, { threadId, pendingMessageId }) => {
    await agent.generateText(
      ctx,
      { threadId },
      {
        pendingMessageId,
        model: mockModel({
          doGenerate: () => {
            claimed();
            return new Promise(() => {});
          },
        }),
      },
    );
  },
});

const { api, createTest } = app.defineModules({
  "batch/batch": batchModule,
  "batch/test": {
    setup,
    start,
    save,
    sendMessage,
    generateNormally,
    list,
    crashWhileSaving,
  },
});

function storedShape(m: MessageDoc) {
  return {
    status: m.status,
    agentName: m.agentName,
    model: m.model,
    provider: m.provider,
    finishReason: m.finishReason,
    usage: m.usage,
    reasoning: m.reasoning,
    text: m.text,
    message: m.message,
  };
}

describe("batch generation by composition", () => {
  test("saves a batch of thread prompts like normal generations", async () => {
    const t = createTest();
    usageCalls.length = 0;
    const [a, b, c, d] = await t.action(api.batch.test.setup, {});

    const batchId = await t.action(api.batch.test.start, {
      items: [a, b, c, d],
    });
    const [providerBatchId] = [...batches.keys()].slice(-1);
    const { requests } = batches.get(providerBatchId)!;
    expect(requests[0].modelId).toBe(MODEL_ID);
    expect(requests[0].options.prompt).toEqual([
      { role: "system", content: "You are a concise assistant." },
      {
        role: "user",
        content: [{ type: "text", text: "Question A" }],
        providerOptions: undefined,
      },
    ]);
    expect(requests[0].options.tools?.map((tool) => tool.name)).toEqual([
      "weather",
    ]);

    // Each thread shows a pending answer while the batch runs.
    expect(await t.action(api.batch.test.save, { batchId })).toBe("pending");
    const placeholders: string[] = [];
    for (const x of [a, b, c, d]) {
      const thread = await t.query(api.batch.test.list, {
        threadId: x.threadId,
      });
      expect(thread.map((m) => [m.message?.role, m.status])).toEqual([
        ["user", "success"],
        ["assistant", "pending"],
      ]);
      placeholders.push(thread[1]._id);
    }
    expect(requests.map((r) => r.id)).toEqual(
      [a, b, c, d].map((x) => x.promptMessageId),
    );
    const [pendingA] = placeholders;

    // The user keeps talking in thread A while the batch runs.
    await t.mutation(api.batch.test.sendMessage, {
      threadId: a.threadId,
      prompt: "Follow-up while waiting",
    });

    completeBatch(providerBatchId, (request) => {
      if (request.id === a.promptMessageId) {
        return {
          type: "text",
          id: request.id,
          status: "succeeded",
          result: generated(ANSWER),
        };
      }
      if (request.id === b.promptMessageId) {
        return {
          type: "text",
          id: request.id,
          status: "succeeded",
          result: generated(
            [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "weather",
                input: JSON.stringify({ city: "Paris" }),
              },
            ],
            "tool-calls",
          ),
        };
      }
      if (request.id === c.promptMessageId) {
        return {
          type: "text",
          id: request.id,
          status: "failed",
          error: { message: "context_length_exceeded" },
        };
      }
      // D is missing from the results entirely.
      return undefined;
    });

    // A poll claims A's result and dies before saving it.
    vi.useFakeTimers({ toFake: ["Date"] });
    const crashed = new Promise<void>((resolve) => (claimed = resolve));
    void t.action(api.batch.test.crashWhileSaving, {
      threadId: a.threadId,
      pendingMessageId: pendingA,
    });
    await crashed;

    // Overlapping polls (or a duplicate webhook) save each result once, and
    // keep the batch open while A's claim may still be live.
    expect(
      await Promise.all([
        t.action(api.batch.test.save, { batchId }),
        t.action(api.batch.test.save, { batchId }),
      ]),
    ).toEqual(["pending", "pending"]);

    // Once the claiming action must have hit its time limit, a poll takes A
    // over, so the paid result isn't lost.
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(await t.action(api.batch.test.save, { batchId })).toBe("done");
    expect(await t.action(api.batch.test.save, { batchId })).toBe("done");

    // A: the answer lands at the prompt's order, before the follow-up, with
    // the same stored shape as a normal generation.
    vi.useFakeTimers();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const threadA = await t.query(api.batch.test.list, {
      threadId: a.threadId,
    });
    expect(
      threadA.map((m) => [m.order, m.stepOrder, m.message?.role, m.status]),
    ).toEqual([
      [0, 0, "user", "success"],
      // The claim that crashed.
      [0, 1, "assistant", "failed"],
      [0, 2, "assistant", "success"],
      [1, 0, "user", "success"],
    ]);
    expect(threadA[1]._id).toBe(pendingA);
    const normalThreadId = await t.action(api.batch.test.generateNormally, {
      prompt: "Question A",
    });
    const normal = await t.query(api.batch.test.list, {
      threadId: normalThreadId,
    });
    expect(storedShape(threadA[2])).toEqual(storedShape(normal[1]));
    expect(storedShape(threadA[2])).toMatchObject({
      status: "success",
      agentName: "Batch Agent",
      model: MODEL_ID,
      provider: PROVIDER,
      finishReason: "stop",
      usage: { promptTokens: 3, completionTokens: 10, totalTokens: 13 },
      reasoning: "Thinking about A",
      text: "Answer for A",
    });

    // B: the batched tool call runs, and the thread continues normally.
    const threadB = await t.query(api.batch.test.list, {
      threadId: b.threadId,
    });
    expect(threadB.map((m) => [m.message?.role, m.status])).toEqual([
      ["user", "success"],
      ["assistant", "success"],
      ["tool", "success"],
      ["assistant", "success"],
    ]);
    expect(threadB[2].message?.content).toMatchObject([
      {
        type: "tool-result",
        output: { type: "text", value: "Sunny in Paris" },
      },
    ]);
    expect(threadB[3].text).toBe("It is sunny in Paris.");

    // C and D: failed, like a failed generation.
    for (const [x, placeholder, error] of [
      [c, placeholders[2], "context_length_exceeded"],
      [d, placeholders[3], "Missing from batch results"],
    ] as const) {
      const thread = await t.query(api.batch.test.list, {
        threadId: x.threadId,
      });
      expect(thread.map((m) => [m.message?.role, m.status, m.error])).toEqual([
        ["user", "success", undefined],
        ["assistant", "failed", error],
      ]);
      expect(thread[1]._id).toBe(placeholder);
    }

    // Usage reaches the usageHandler once per model call: B's two steps, A
    // once it was taken over, and the normal control generation.
    expect(usageCalls.map((u) => [u.threadId, u.model, u.provider])).toEqual([
      [b.threadId, MODEL_ID, PROVIDER],
      [b.threadId, MODEL_ID, PROVIDER],
      [a.threadId, MODEL_ID, PROVIDER],
      [normalThreadId, MODEL_ID, PROVIDER],
    ]);
  });
});
