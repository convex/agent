import { describe, expect, test } from "vitest";
import { Agent, createThread } from "../index.js";
import { v } from "convex/values";
import { APICallError, type LanguageModelV4Source } from "@ai-sdk/provider";
import { app, components } from "./setup.test.js";
import { mockModel } from "./mockModel.js";
import { runStreamCleanup } from "./streamText.js";
import type { StreamingOptions } from "./streaming.js";
import { errorToString } from "./utils.js";

const FINAL_TEXT = "Hello from the model";
const PROVIDER_FAILURE_TEXT = "Mock provider failure";
const CLEANUP_FAILURE_TEXT = "saving the failure rejected";

function hasKeys(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    keys.every((key) => key in value)
  );
}

const agent = new Agent(components.agent, {
  name: "stream-test",
  languageModel: mockModel({
    content: [{ type: "text", text: FINAL_TEXT }],
  }),
});

const emptyAgent = new Agent(components.agent, {
  name: "empty-stream-test",
  languageModel: mockModel({
    content: [],
    providerMetadata: { mock: { emptyResponse: true } },
  }),
});

const failingAgent = new Agent(components.agent, {
  name: "failing-stream-test",
  languageModel: mockModel({
    content: [{ type: "text", text: "partial response" }],
    fail: { error: PROVIDER_FAILURE_TEXT },
  }),
});

const rejectedRequestAgent = new Agent(components.agent, {
  name: "rejected-request-stream-test",
  languageModel: mockModel({
    doGenerate: async () => {
      throw new Error("unused");
    },
    doStream: async () => {
      throw new APICallError({
        message: PROVIDER_FAILURE_TEXT,
        url: "https://provider.test/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      });
    },
  }),
});

const sourceParts: LanguageModelV4Source[] = [
  {
    type: "source",
    sourceType: "url",
    id: "source-url-1",
    url: "https://example.com/reference",
    title: "Reference",
  },
  {
    type: "source",
    sourceType: "document",
    id: "source-document-1",
    mediaType: "application/pdf",
    title: "Document",
    filename: "document.pdf",
  },
];

const sourceAgent = new Agent(components.agent, {
  name: "source-stream-test",
  languageModel: mockModel({
    content: [{ type: "text", text: FINAL_TEXT }, ...sourceParts],
  }),
});

// Action that exercises streamText with saveStreamDeltas.returnImmediately=true.
// It consumes the stream after streamText returns, simulating the HTTP response
// path described in issue #265.
const streamTextReturnImmediately = app.action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const result = await agent.streamText(
      ctx,
      { threadId },
      { prompt: "Test" },
      {
        saveStreamDeltas: {
          returnImmediately: true,
          chunking: "word",
          throttleMs: 0,
        },
      },
    );
    // Drain the stream the way an HTTP response would. This triggers
    // onStepFinish for every step, including the final one.
    await result.consumeStream();
  },
});

const streamTextEmptyAwaited = app.action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    await emptyAgent.streamText(
      ctx,
      { threadId },
      { prompt: "Test" },
      { saveStreamDeltas: true },
    );
    return { ok: true };
  },
});

const streamTextEmptyReturnImmediately = app.action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const result = await emptyAgent.streamText(
      ctx,
      { threadId },
      { prompt: "Test" },
      {
        saveStreamDeltas: {
          returnImmediately: true,
          throttleMs: 0,
        },
      },
    );
    await result.consumeStream();
    return { ok: true };
  },
});

const streamTextThrottled = app.action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const result = await agent.streamText(
      ctx,
      { threadId },
      { prompt: "Test" },
      {
        saveStreamDeltas: {
          returnImmediately: true,
          chunking: "word",
          throttleMs: 60_000,
        },
      },
    );
    await result.consumeStream();
    return { ok: true };
  },
});

// Same as streamTextThrottled, but awaited: streamText consumes the stream
// itself, so the terminal transition happens at end-of-stream.
const streamTextThrottledAwaited = app.action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    await agent.streamText(
      ctx,
      { threadId },
      { prompt: "Test" },
      {
        saveStreamDeltas: {
          chunking: "word",
          throttleMs: 60_000,
        },
      },
    );
    return { ok: true };
  },
});

const streamTextNoStorage = app.action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    await agent.streamText(
      ctx,
      { threadId },
      { prompt: "Test" },
      {
        saveStreamDeltas: { chunking: "word", throttleMs: 0 },
        storageOptions: { saveMessages: "none" },
      },
    );
    return { ok: true };
  },
});

const streamTextNoStorageImmediate = app.action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const r = await agent.streamText(
      ctx,
      { threadId },
      { prompt: "Test" },
      {
        saveStreamDeltas: {
          returnImmediately: true,
          chunking: "word",
          throttleMs: 0,
        },
        storageOptions: { saveMessages: "none" },
      },
    );
    await r.consumeStream();
    return { ok: true };
  },
});

const streamTextCleanupFailure = app.action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const providerErrors: string[] = [];
    let aborts = 0;
    const failingCtx = {
      ...ctx,
      runMutation: (async (reference, args) => {
        if (
          hasKeys(args, ["messageId", "result"]) ||
          (hasKeys(args, ["failPendingSteps"]) &&
            JSON.stringify(args).includes('"status":"failed"'))
        ) {
          throw new Error(CLEANUP_FAILURE_TEXT);
        }
        return ctx.runMutation(reference, args);
      }) as typeof ctx.runMutation,
    };
    let caught: string | undefined;
    try {
      await failingAgent.streamText(
        failingCtx,
        { threadId },
        {
          prompt: "Test",
          onError: ({ error }) => {
            providerErrors.push(errorToString(error));
          },
          onAbort: () => {
            aborts += 1;
          },
        },
        { saveStreamDeltas: { chunking: "word", throttleMs: 0 } },
      );
    } catch (error) {
      caught = errorToString(error);
    }
    return { providerErrors, aborts, caught };
  },
});

const streamTextFullStreamErrors = app.action({
  args: { threadId: v.string(), returnImmediately: v.boolean() },
  handler: async (ctx, { threadId, returnImmediately }) => {
    const result = await failingAgent.streamText(
      ctx,
      { threadId },
      { prompt: "Test", onError: () => {} },
      { saveStreamDeltas: { returnImmediately, throttleMs: 0 } },
    );
    const errors: string[] = [];
    for await (const part of result.fullStream) {
      if (part.type === "error") errors.push(errorToString(part.error));
    }
    return errors;
  },
});

const streamTextRejectedRequest = app.action({
  args: {
    threadId: v.string(),
    saveStreamDeltas: v.union(
      v.boolean(),
      v.object({
        chunking: v.literal("word"),
        throttleMs: v.number(),
        returnImmediately: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, { threadId, saveStreamDeltas }) => {
    const providerErrors: string[] = [];
    const result = await rejectedRequestAgent.streamText(
      ctx,
      { threadId, userId: "u1" },
      {
        prompt: "Test",
        onError: ({ error }) => {
          providerErrors.push(errorToString(error));
        },
      },
      { saveStreamDeltas },
    );
    await result.consumeStream();
    return providerErrors;
  },
});

// A generation that someone aborts out of band while it is streaming, the way
// a client cancelling a request would: list the streaming row and abort it.
// The throttle holds every part after the first, so the only remaining delta
// write is the one the finishing save drains, and the component refuses it.
const streamTextAbortedMidStream = app.action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const result = await agent.streamText(
      ctx,
      { threadId },
      { prompt: "Test" },
      {
        saveStreamDeltas: {
          returnImmediately: true,
          chunking: "word",
          throttleMs: 60_000,
        },
      },
    );
    for (let i = 0; i < 50; i++) {
      const streaming = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming"],
      });
      if (streaming.length) {
        await ctx.runMutation(components.agent.streams.abort, {
          streamId: streaming[0].streamId,
          reason: "external abort",
        });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await result.consumeStream();
  },
});

// An empty generation on the awaited path with nothing stored: no part ever
// reaches the streamer, so no row exists when consumption ends.
const streamTextEmptyNoStorageAwaited = app.action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    await emptyAgent.streamText(
      ctx,
      { threadId },
      { prompt: "Test" },
      {
        saveStreamDeltas: { chunking: "word", throttleMs: 0 },
        storageOptions: { saveMessages: "none" },
      },
    );
    return { ok: true };
  },
});

const streamTextWithSources = app.action({
  args: { threadId: v.string(), sendSources: v.optional(v.boolean()) },
  handler: async (ctx, { threadId, sendSources }) => {
    const saveStreamDeltas: StreamingOptions = {
      chunking: "word",
      throttleMs: 0,
    };
    if (sendSources !== undefined) {
      saveStreamDeltas.sendSources = sendSources;
    }
    await sourceAgent.streamText(
      ctx,
      { threadId },
      { prompt: "Test" },
      { saveStreamDeltas },
    );
    return { ok: true };
  },
});

const { api, createTest } = app.defineModules({
  streamText: {
    streamTextReturnImmediately,
    streamTextEmptyAwaited,
    streamTextEmptyReturnImmediately,
    streamTextThrottled,
    streamTextThrottledAwaited,
    streamTextNoStorage,
    streamTextNoStorageImmediate,
    streamTextCleanupFailure,
    streamTextFullStreamErrors,
    streamTextRejectedRequest,
    streamTextAbortedMidStream,
    streamTextEmptyNoStorageAwaited,
    streamTextWithSources,
  },
});

describe("streamText source visibility", () => {
  test.each([
    { name: "omitted", sendSources: undefined },
    { name: "enabled", sendSources: true },
  ])(
    "keeps awaited deltas healthy with sources $name",
    async ({ sendSources }) => {
      const t = createTest();
      const threadId = await t.run(async (ctx) =>
        createThread(ctx, components.agent, { userId: "u1" }),
      );

      await t.action(api.streamText.streamTextWithSources, {
        threadId,
        ...(sendSources === undefined ? {} : { sendSources }),
      });

      const streams = await t.run(async (ctx) =>
        ctx.runQuery(components.agent.streams.list, {
          threadId,
          statuses: ["streaming", "finished", "aborted"],
        }),
      );
      expect(streams).toEqual([
        expect.objectContaining({ status: "finished" }),
      ]);
      const deltas = await t.run(async (ctx) =>
        ctx.runQuery(components.agent.streams.listDeltas, {
          threadId,
          cursors: streams.map((stream) => ({
            streamId: stream.streamId,
            cursor: 0,
          })),
        }),
      );
      const parts = deltas.flatMap((delta) => delta.parts);
      expect(
        parts
          .filter((part) => part.type === "text-delta")
          .map((part) => part.delta)
          .join(""),
      ).toBe(FINAL_TEXT);
      const streamedSources = parts.filter(
        (part) => part.type === "source-url" || part.type === "source-document",
      );
      expect(streamedSources).toEqual(
        sendSources
          ? [
              expect.objectContaining({
                type: "source-url",
                sourceId: "source-url-1",
                url: "https://example.com/reference",
                title: "Reference",
              }),
              expect.objectContaining({
                type: "source-document",
                sourceId: "source-document-1",
                mediaType: "application/pdf",
                title: "Document",
                filename: "document.pdf",
              }),
            ]
          : [],
      );

      const messages = await t.run(async (ctx) =>
        sourceAgent.listMessages(ctx, {
          threadId,
          paginationOpts: { cursor: null, numItems: 50 },
        }),
      );
      expect(
        messages.page.filter(
          (message) => message.message?.role === "assistant",
        ),
      ).toMatchObject([{ sources: sourceParts }]);
    },
  );
});

describe("streamText with saveStreamDeltas.returnImmediately (issue #265)", () => {
  test("persists the final assistant text to the messages table", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "u1" }),
    );

    await t.action(api.streamText.streamTextReturnImmediately, { threadId });

    // Allow any background work scheduled by consumeStream to settle.
    await t.finishAllScheduledFunctions(() => {});

    const messages = await t.run(async (ctx) =>
      agent.listMessages(ctx, {
        threadId,
        paginationOpts: { cursor: null, numItems: 50 },
      }),
    );

    const assistantTextMessages = messages.page.filter(
      (m) =>
        m.message?.role === "assistant" &&
        typeof m.text === "string" &&
        m.text.length > 0,
    );
    expect(
      assistantTextMessages.length,
      "expected at least one persisted assistant message with text",
    ).toBeGreaterThan(0);

    const combined = assistantTextMessages.map((m) => m.text).join("");
    expect(combined).toContain(FINAL_TEXT);

    // The stream should be marked finished, not stuck in "streaming".
    const stillStreaming = await t.run(async (ctx) =>
      ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming"],
      }),
    );
    expect(
      stillStreaming,
      "stream should not be stuck in 'streaming' status",
    ).toHaveLength(0);
  });
});

describe("streamText abort cleanup", () => {
  test("finishes durable cleanup before invoking onAbort", async () => {
    const calls: string[] = [];
    let resolveStreamer!: () => void;
    const syncFailure = new Error("synchronous pending message cleanup");

    const cleanup = runStreamCleanup({
      failCall: () => {
        calls.push("call.fail");
        throw syncFailure;
      },
      failStreamer: () =>
        new Promise<void>((resolve) => {
          calls.push("streamer.fail");
          resolveStreamer = resolve;
        }),
      onAbort: () => {
        calls.push("user.onAbort");
      },
    });

    await Promise.resolve();
    expect(calls).toEqual(["call.fail", "streamer.fail"]);
    resolveStreamer();
    await expect(cleanup).rejects.toBe(syncFailure);

    expect(calls).toEqual(["call.fail", "streamer.fail", "user.onAbort"]);
  });

  test("surfaces a cleanup failure without hiding the provider error", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "u1" }),
    );

    const { providerErrors, aborts, caught } = await t.action(
      api.streamText.streamTextCleanupFailure,
      { threadId },
    );

    expect(providerErrors).toEqual([PROVIDER_FAILURE_TEXT]);
    expect(aborts).toBe(0);
    expect(caught).toBe(CLEANUP_FAILURE_TEXT);

    const streaming = await t.run(async (ctx) =>
      ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming"],
      }),
    );
    const aborted = await t.run(async (ctx) =>
      ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["aborted"],
      }),
    );
    expect(streaming).toHaveLength(0);
    expect(aborted).toHaveLength(1);
  });
});

describe("provider errors reach fullStream", () => {
  test.each([false, true])(
    "with saveStreamDeltas (returnImmediately: %s)",
    async (returnImmediately) => {
      const t = createTest();
      const threadId = await t.run(async (ctx) =>
        createThread(ctx, components.agent, { userId: "u1" }),
      );
      const errors = await t.action(api.streamText.streamTextFullStreamErrors, {
        threadId,
        returnImmediately,
      });
      expect(errors).toEqual([PROVIDER_FAILURE_TEXT]);
    },
  );
});

describe("provider rejects the first request (issue #387)", () => {
  test.each([
    ["awaited deltas", { chunking: "word" as const, throttleMs: 250 }],
    [
      "returnImmediately",
      { chunking: "word" as const, throttleMs: 250, returnImmediately: true },
    ],
    ["no deltas", false],
  ])("leaves no unhandled rejection with %s", async (_, saveStreamDeltas) => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "u1" }),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    // Convex runs actions outside Node. The AI SDK only observes some of its
    // internal promises when it detects Node (fixed in ai 7.0.119).
    const release = process.release;
    Object.defineProperty(process, "release", {
      value: { ...release, name: "convex" },
      configurable: true,
    });
    process.on("unhandledRejection", onUnhandled);
    try {
      const providerErrors = await t.action(
        api.streamText.streamTextRejectedRequest,
        { threadId, saveStreamDeltas },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(providerErrors).toEqual([PROVIDER_FAILURE_TEXT]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      Object.defineProperty(process, "release", {
        value: release,
        configurable: true,
      });
    }
    expect(unhandled.map(errorToString)).toEqual([]);
  });
});

describe("streamText with an empty final step (issue #274)", () => {
  test.each([
    ["awaited", api.streamText.streamTextEmptyAwaited],
    ["returnImmediately", api.streamText.streamTextEmptyReturnImmediately],
  ])(
    "finalizes the pending assistant message in the %s path",
    async (_, fn) => {
      const t = createTest();
      const threadId = await t.run(async (ctx) =>
        createThread(ctx, components.agent, { userId: "u1" }),
      );

      await t.action(fn, { threadId });
      await t.finishAllScheduledFunctions(() => {});

      const messages = await t.run(async (ctx) =>
        emptyAgent.listMessages(ctx, {
          threadId,
          paginationOpts: { cursor: null, numItems: 50 },
        }),
      );

      expect(
        messages.page.filter((message) => message.status === "pending"),
      ).toHaveLength(0);
      expect(messages.page).toContainEqual(
        expect.objectContaining({
          status: "success",
          message: { role: "assistant", content: [] },
          model: "mock-model-id",
          provider: "mock-provider",
          providerMetadata: { mock: { emptyResponse: true } },
          usage: expect.objectContaining({
            promptTokens: 3,
            completionTokens: 10,
            totalTokens: 13,
          }),
        }),
      );

      const stillStreaming = await t.run(async (ctx) =>
        ctx.runQuery(components.agent.streams.list, {
          threadId,
          statuses: ["streaming"],
        }),
      );
      expect(stillStreaming).toHaveLength(0);
    },
  );
});

describe("saveStreamDeltas flushes buffered parts (issue #323)", () => {
  test("deltas hold the full text when the generation outpaces the throttle", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "u1" }),
    );

    await t.action(api.streamText.streamTextThrottled, { threadId });
    await t.finishAllScheduledFunctions(() => {});

    const streams = await t.run(async (ctx) =>
      ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming", "finished", "aborted"],
      }),
    );
    const deltas = await t.run(async (ctx) =>
      ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: streams.map((s) => ({ streamId: s.streamId, cursor: 0 })),
      }),
    );

    expect(streams).toHaveLength(1);
    expect(streams[0].status).toBe("finished");

    let cursor = 0;
    for (const delta of deltas) {
      expect(delta.start).toBe(cursor);
      cursor = delta.end;
    }

    const parts = deltas.flatMap((d) => d.parts);
    const types = parts.map((p) => p.type);
    expect(types.at(0)).toBe("start");
    expect(types).toContain("text-start");
    expect(types).toContain("text-end");
    expect(types.at(-1)).toBe("finish");
    expect(
      parts
        .filter((p) => p.type === "text-delta")
        .map((p) => (p as { delta?: string }).delta ?? "")
        .join(""),
    ).toBe(FINAL_TEXT);

    const messages = await t.run(async (ctx) =>
      agent.listMessages(ctx, {
        threadId,
        paginationOpts: { cursor: null, numItems: 50 },
      }),
    );
    expect(
      messages.page
        .filter((m) => m.message?.role === "assistant")
        .map((m) => m.text)
        .join(""),
    ).toBe(FINAL_TEXT);
  });

  test("an out of band abort fails the generation instead of saving it", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "u1" }),
    );

    await t.action(api.streamText.streamTextAbortedMidStream, { threadId });
    await t.finishAllScheduledFunctions(() => {});

    const streams = await t.run(async (ctx) =>
      ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming", "finished", "aborted"],
      }),
    );
    expect(streams).toHaveLength(1);
    expect(streams[0].status).toBe("aborted");

    // Nobody gets to save a successful message onto a row someone aborted.
    const messages = await t.run(async (ctx) =>
      agent.listMessages(ctx, {
        threadId,
        paginationOpts: { cursor: null, numItems: 50 },
      }),
    );
    expect(
      messages.page
        .filter((m) => m.message?.role === "assistant")
        .map((m) => m.status),
    ).toEqual(["failed"]);
  });

  test("the awaited path captures the stream-level finish chunk", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "u1" }),
    );

    await t.action(api.streamText.streamTextThrottledAwaited, { threadId });
    await t.finishAllScheduledFunctions(() => {});

    const streams = await t.run(async (ctx) =>
      ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming", "finished", "aborted"],
      }),
    );
    const deltas = await t.run(async (ctx) =>
      ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: streams.map((s) => ({ streamId: s.streamId, cursor: 0 })),
      }),
    );

    expect(streams).toHaveLength(1);
    expect(streams[0].status).toBe("finished");

    let cursor = 0;
    for (const delta of deltas) {
      expect(delta.start).toBe(cursor);
      cursor = delta.end;
    }

    const parts = deltas.flatMap((d) => d.parts);
    const types = parts.map((p) => p.type);
    // Unlike the returnImmediately path, nothing stops accepting parts early
    // here: consumeStream drains at EOF, so the trailing chunks the AI SDK
    // emits after the last onStepEnd are persisted too.
    expect(types.at(0)).toBe("start");
    expect(types.at(-1)).toBe("finish");
    expect(types).toContain("finish-step");
    expect(
      parts
        .filter((p) => p.type === "text-delta")
        .map((p) => (p as { delta?: string }).delta ?? "")
        .join(""),
    ).toBe(FINAL_TEXT);
  });
});

describe("stream finish ownership without message storage", () => {
  test("the row still terminates when saveMessages is none", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "u1" }),
    );

    await t.action(api.streamText.streamTextNoStorage, { threadId });
    await t.finishAllScheduledFunctions(() => {});

    const streams = await t.run(async (ctx) =>
      ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming", "finished", "aborted"],
      }),
    );
    expect(streams.map((s) => s.status)).toEqual(["finished"]);
  });

  test("leaves no row behind when the generation produces nothing", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "u1" }),
    );

    await t.action(api.streamText.streamTextEmptyNoStorageAwaited, {
      threadId,
    });
    await t.finishAllScheduledFunctions(() => {});

    const streams = await t.run(async (ctx) =>
      ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming", "finished", "aborted"],
      }),
    );
    expect(streams.filter((s) => s.status === "streaming")).toEqual([]);
  });

  test("the row still terminates on the returnImmediately path", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "u1" }),
    );

    await t.action(api.streamText.streamTextNoStorageImmediate, { threadId });
    await t.finishAllScheduledFunctions(() => {});

    const streams = await t.run(async (ctx) =>
      ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming", "finished", "aborted"],
      }),
    );
    expect(streams.map((s) => s.status)).toEqual(["finished"]);
  });
});
