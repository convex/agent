import { describe, expect, test } from "vitest";
import { Agent, createThread, createTool } from "../index.js";
import { v, type ObjectType } from "convex/values";
import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4Source,
  type LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { isStepCount, simulateReadableStream, type StopCondition } from "ai";
import { z } from "zod/v4";
import { app, components } from "./setup.test.js";
import { mockModel } from "./mockModel.js";
import { runStreamCleanup } from "./streamText.js";
import type { StreamingOptions } from "./streaming.js";
import type { ActionCtx } from "./types.js";
import type { MessageDoc } from "../../validators.js";
import { errorToString } from "./utils.js";

const FINAL_TEXT = "Hello from the model";
const PROVIDER_FAILURE_TEXT = "Mock provider failure";
const CLEANUP_FAILURE_TEXT = "finalizeMessage rejected";

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
        if (hasKeys(args, ["messageId", "result"])) {
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

const lookupTool = createTool({
  description: "Look something up.",
  inputSchema: z.object({}),
  execute: async () => ({ ok: true }),
});

const lookupNeedingApprovalTool = createTool({
  description: "Look something up.",
  inputSchema: z.object({}),
  needsApproval: () => true,
  execute: async () => ({ ok: true }),
});

const LOOKUP_CALL = {
  type: "tool-call",
  toolCallId: "tc-lookup",
  toolName: "lookup",
  input: "{}",
} as const;
const ANSWER_TEXT = "Looked it up";
const STEP_USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

const ANSWER_CHUNKS: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: ANSWER_TEXT },
  { type: "text-end", id: "t" },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: undefined },
    usage: STEP_USAGE,
  },
];

// mockModel reports "stop" for every step, so a model that reports
// "tool-calls" for its tool step, or fails, needs its own stream.
function toolCallsFinishModel(failure: Failure | undefined) {
  const toolStep: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    LOOKUP_CALL,
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: STEP_USAGE,
    },
  ];
  const failingAnswer: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: ANSWER_TEXT },
    { type: "text-end", id: "t" },
    { type: "error", error: PROVIDER_FAILURE_TEXT },
    {
      type: "finish",
      finishReason: { unified: "error", raw: undefined },
      usage: STEP_USAGE,
    },
  ];
  const streams =
    failure === "finalStep"
      ? [toolStep, failingAnswer]
      : failure === "finalStepOnce"
        ? [toolStep, failingAnswer, ANSWER_CHUNKS]
        : [toolStep, ANSWER_CHUNKS];
  let streamCall = 0;
  let generateCall = 0;
  return mockModel({
    doStream: async () => {
      if (failure === "beforeFirstChunk") {
        throw new Error(PROVIDER_FAILURE_TEXT);
      }
      return {
        stream: simulateReadableStream({ chunks: streams[streamCall++] }),
      };
    },
    doGenerate: async () => {
      if (generateCall++ === 0) {
        return {
          content: [LOOKUP_CALL],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: STEP_USAGE,
          warnings: [],
        };
      }
      if (failure === "finalStep") throw new Error(PROVIDER_FAILURE_TEXT);
      return {
        content: [{ type: "text", text: ANSWER_TEXT }],
        finishReason: { unified: "stop", raw: undefined },
        usage: STEP_USAGE,
        warnings: [],
      };
    },
  });
}

function beforeSecondStep(model: LanguageModelV4, hook: () => Promise<void>) {
  const doStream = model.doStream.bind(model);
  const doGenerate = model.doGenerate.bind(model);
  let call = 0;
  // A provider call made with an aborted signal rejects, as fetch does.
  model.doStream = async (options) => {
    if (call++ === 1) await hook();
    options.abortSignal?.throwIfAborted();
    return doStream(options);
  };
  model.doGenerate = async (options) => {
    if (call++ === 1) await hook();
    options.abortSignal?.throwIfAborted();
    return doGenerate(options);
  };
  return model;
}

// Says "stop" the first time it is asked about a step and "continue" after
// that, so the run only matches the SDK's own decision when nothing else
// consults stop conditions.
function stopOnFirstLook(): StopCondition<any> {
  const seen = new Set<number>();
  return ({ steps }) => {
    if (seen.has(steps.length)) return false;
    seen.add(steps.length);
    return true;
  };
}

type SavedMessage = {
  role: string | undefined;
  parts: string[];
  status: string;
};

function summarize(page: MessageDoc[]): SavedMessage[] {
  return page
    .slice()
    .reverse()
    .map((m) => ({
      role: m.message?.role,
      parts:
        typeof m.message?.content === "string"
          ? ["text"]
          : (m.message?.content ?? []).map((p) => p.type),
      status: m.status,
    }));
}

async function readThread(
  ctx: Pick<ActionCtx, "runQuery">,
  threadId: string,
): Promise<SavedMessage[]> {
  const messages = await agent.listMessages(ctx as ActionCtx, {
    threadId,
    excludeToolMessages: false,
    paginationOpts: { cursor: null, numItems: 50 },
  });
  return summarize(messages.page);
}

const twoStepScenario = v.union(
  v.literal("toolCallsFinish"),
  v.literal("deniedApproval"),
  v.literal("stopFinish"),
  v.literal("flakyStop"),
  v.literal("needsApproval"),
);
const twoStepMode = v.union(
  v.literal("awaited"),
  v.literal("returnImmediately"),
  v.literal("noDeltas"),
);
const twoStepArgs = {
  threadId: v.string(),
  scenario: twoStepScenario,
  mode: twoStepMode,
  failUsageOn: v.optional(v.number()),
  abort: v.optional(
    v.union(v.literal("duringSecondStep"), v.literal("afterFirstStep")),
  ),
  prepareStepThrows: v.optional(v.boolean()),
  failure: v.optional(
    v.union(
      v.literal("finalStep"),
      v.literal("finalStepOnce"),
      v.literal("beforeFirstChunk"),
    ),
  ),
  streamRetries: v.optional(v.number()),
  callerRequestsRetry: v.optional(v.boolean()),
  callerThrows: v.optional(
    v.union(v.literal("onStepEnd"), v.literal("onEnd"), v.literal("onError")),
  ),
  failStore: v.optional(
    v.union(v.literal("final"), v.literal("finalOnce"), v.literal("first")),
  ),
  failMessageFailure: v.optional(v.boolean()),
};
type Failure = NonNullable<ObjectType<typeof twoStepArgs>["failure"]>;
type TwoStepArgs = ObjectType<typeof twoStepArgs>;

function twoStepAgent(
  ctx: ActionCtx,
  args: TwoStepArgs,
  abortController: AbortController,
) {
  const observed = {
    usageCalls: 0,
    duringSecondStep: undefined as SavedMessage[] | undefined,
    atCallerOnEnd: undefined as SavedMessage[] | undefined,
    callerOnErrorCalls: 0,
    signalAbortedInCallerOnError: null as boolean | null,
    signalAborted: false,
  };
  let providerSignal: AbortSignal | undefined;
  const watchSignal = (signal: AbortSignal | undefined) => {
    providerSignal = signal;
    signal?.addEventListener("abort", () => {
      observed.signalAborted = true;
    });
  };
  const model =
    args.scenario === "stopFinish"
      ? mockModel({
          contentSteps: [[LOOKUP_CALL], [{ type: "text", text: ANSWER_TEXT }]],
        })
      : toolCallsFinishModel(args.failure);
  const doStream = model.doStream.bind(model);
  const doGenerate = model.doGenerate.bind(model);
  model.doStream = async (options) => {
    watchSignal(options.abortSignal);
    return doStream(options);
  };
  model.doGenerate = async (options) => {
    watchSignal(options.abortSignal);
    return doGenerate(options);
  };
  beforeSecondStep(model, async () => {
    observed.duringSecondStep = await readThread(ctx, args.threadId);
    if (args.abort === "duringSecondStep") abortController.abort();
  });
  const agent = new Agent(components.agent, {
    name: "two-step-test",
    languageModel: model,
    tools: {
      lookup:
        args.scenario === "needsApproval"
          ? lookupNeedingApprovalTool
          : lookupTool,
    },
    usageHandler: async () => {
      observed.usageCalls += 1;
      if (observed.usageCalls === args.failUsageOn) {
        throw new Error("usage handler failed");
      }
    },
  });
  const abortAfterFirstStep: StopCondition<any> = ({ steps }) => {
    if (args.abort === "afterFirstStep" && steps.length === 1) {
      abortController.abort();
    }
    return false;
  };
  const callArgs = {
    prompt: "Go.",
    abortSignal: abortController.signal,
    stopWhen: [
      ...(args.scenario === "flakyStop" ? [stopOnFirstLook()] : []),
      abortAfterFirstStep,
      isStepCount(5),
    ],
    ...(args.scenario === "deniedApproval"
      ? { toolApproval: () => ({ type: "denied" as const, reason: "No." }) }
      : {}),
    prepareStep: async ({ stepNumber }: { stepNumber: number }) => {
      if (args.prepareStepThrows && stepNumber === 1) {
        throw new Error("prepareStep failed");
      }
      return undefined;
    },
    onEnd: async () => {
      observed.atCallerOnEnd = await readThread(ctx, args.threadId);
      if (args.callerThrows === "onEnd") throw new Error("caller onEnd");
    },
    onStepEnd: async () => {
      if (args.callerThrows === "onStepEnd") {
        throw new Error("caller onStepEnd");
      }
    },
    onError: async () => {
      observed.callerOnErrorCalls += 1;
      observed.signalAbortedInCallerOnError = providerSignal?.aborted ?? null;
      if (args.callerThrows === "onError") throw new Error("caller onError");
      return args.callerRequestsRetry ? { retry: true as const } : undefined;
    },
    ...(args.streamRetries === undefined
      ? {}
      : { streamRetries: args.streamRetries }),
    maxRetries: 0,
  };
  return { agent, observed, callArgs };
}

// Fails the save of the final answer (once, for a transient failure), or of
// the first step's tool call, before anything is stored; and optionally the
// marking of the pending message as failed.
function failingStore(ctx: ActionCtx, args: TwoStepArgs): ActionCtx {
  const failStore = args.failStore;
  if (!failStore && !args.failMessageFailure) return ctx;
  const failingPart = failStore === "first" ? "tool-call" : "text";
  let failures = 0;
  return {
    ...ctx,
    runMutation: (async (reference, mutationArgs) => {
      const result = (mutationArgs as { result?: { status?: string } }).result;
      if (args.failMessageFailure && result?.status === "failed") {
        throw new Error("failing the message failed");
      }
      const messages = (mutationArgs as { messages?: MessageDoc[] }).messages;
      const stores = messages?.some(
        (m) =>
          m.message?.role === "assistant" &&
          Array.isArray(m.message.content) &&
          m.message.content.some((p) => p.type === failingPart),
      );
      if (
        failStore &&
        stores &&
        (failStore !== "finalOnce" || failures++ === 0)
      ) {
        throw new Error(
          `${failStore === "first" ? "first" : "final"} store failed`,
        );
      }
      return ctx.runMutation(reference, mutationArgs);
    }) as ActionCtx["runMutation"],
  };
}

const streamTextTwoSteps = app.action({
  args: twoStepArgs,
  handler: async (ctx, args) => {
    const { agent, observed, callArgs } = twoStepAgent(
      ctx,
      args,
      new AbortController(),
    );
    let error: string | undefined;
    let steps: number | undefined;
    try {
      const result = await agent.streamText(
        failingStore(ctx, args),
        { threadId: args.threadId },
        callArgs,
        args.mode === "noDeltas"
          ? {}
          : {
              saveStreamDeltas: {
                returnImmediately: args.mode === "returnImmediately",
                throttleMs: 0,
              },
            },
      );
      await result.consumeStream();
      steps = await result.steps.then(
        (s) => s.length,
        () => undefined,
      );
    } catch (e) {
      error = errorToString(e);
    }
    return { ...observed, steps: steps ?? null, error: error ?? null };
  },
});

const generateTextTwoSteps = app.action({
  args: twoStepArgs,
  handler: async (ctx, args) => {
    const { agent, observed, callArgs } = twoStepAgent(
      ctx,
      args,
      new AbortController(),
    );
    let error: string | undefined;
    let steps: number | undefined;
    try {
      const result = await agent.generateText(
        failingStore(ctx, args),
        { threadId: args.threadId },
        callArgs,
      );
      steps = result.steps.length;
    } catch (e) {
      error = errorToString(e);
    }
    return { ...observed, steps: steps ?? null, error: error ?? null };
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
    streamTextRejectedRequest,
    streamTextAbortedMidStream,
    streamTextEmptyNoStorageAwaited,
    streamTextWithSources,
    streamTextTwoSteps,
    generateTextTwoSteps,
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
    expect(types).toContain("finish-step");
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

async function runTwoSteps(
  fn: "streamText" | "generateText",
  args: Omit<TwoStepArgs, "threadId">,
) {
  const t = createTest();
  const threadId = await t.run(async (ctx) =>
    createThread(ctx, components.agent, { userId: "u1" }),
  );
  const observed = await t.action(
    fn === "streamText"
      ? api.streamText.streamTextTwoSteps
      : api.streamText.generateTextTwoSteps,
    { threadId, ...args },
  );
  await t.finishAllScheduledFunctions(() => {});

  const saved = await t.run(async (ctx) => readThread(ctx, threadId));
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
  const streamedText = deltas
    .flatMap((d) => d.parts)
    .filter((p) => p.type === "text-delta")
    .map((p) => (p as { delta?: string }).delta ?? "")
    .join("");
  return {
    ...observed,
    saved,
    streamStatuses: streams.map((s) => s.status),
    streamedText,
  };
}

const USER = { role: "user", parts: ["text"], status: "success" };
const PLACEHOLDER = { role: "assistant", parts: [], status: "pending" };
const FAILED_TAIL = { role: "assistant", parts: [], status: "failed" };
const LOOKUP_STEP = [
  { role: "assistant", parts: ["tool-call"], status: "success" },
  { role: "tool", parts: ["tool-result"], status: "success" },
];
const DENIED_STEP = [
  {
    role: "assistant",
    parts: ["tool-call", "tool-approval-request"],
    status: "success",
  },
  {
    role: "tool",
    parts: ["tool-approval-response", "tool-result"],
    status: "success",
  },
];
const ANSWER = { role: "assistant", parts: ["text"], status: "success" };

const modes = [
  { mode: "awaited", streamed: true },
  { mode: "returnImmediately", streamed: true },
  { mode: "noDeltas", streamed: false },
] as const;

function stream(streamed: boolean, status: "finished" | "aborted") {
  return streamed
    ? { streamStatuses: [status] }
    : { streamStatuses: [], streamedText: "" };
}

describe.each(modes)(
  "streamText saves every step the SDK runs, $mode (issue #388)",
  ({ mode, streamed }) => {
    test.each([
      { scenario: "toolCallsFinish", firstStep: LOOKUP_STEP },
      { scenario: "deniedApproval", firstStep: DENIED_STEP },
      { scenario: "stopFinish", firstStep: LOOKUP_STEP },
    ] as const)("$scenario", async ({ scenario, firstStep }) => {
      expect(await runTwoSteps("streamText", { scenario, mode })).toEqual({
        steps: 2,
        usageCalls: 2,
        error: null,
        duringSecondStep: [USER, ...firstStep, PLACEHOLDER],
        atCallerOnEnd: expect.anything(),
        callerOnErrorCalls: 0,
        signalAbortedInCallerOnError: null,
        signalAborted: false,
        saved: [USER, ...firstStep, ANSWER],
        streamedText: ANSWER_TEXT,
        ...stream(streamed, "finished"),
      });
    });

    test("stopping for approval finalizes the only step", async () => {
      expect(
        await runTwoSteps("streamText", { scenario: "needsApproval", mode }),
      ).toMatchObject({
        steps: 1,
        usageCalls: 1,
        error: null,
        saved: [
          USER,
          {
            role: "assistant",
            parts: ["tool-call", "tool-approval-request"],
            status: "success",
          },
        ],
        ...stream(streamed, "finished"),
        streamedText: "",
      });
    });

    test("an abort during the second step keeps the first", async () => {
      expect(
        await runTwoSteps("streamText", {
          scenario: "toolCallsFinish",
          mode,
          abort: "duringSecondStep",
        }),
      ).toMatchObject({
        usageCalls: 1,
        error: null,
        saved: [USER, ...LOOKUP_STEP, FAILED_TAIL],
        ...stream(streamed, "aborted"),
      });
    });

    test("only the SDK consults stop conditions", async () => {
      expect(
        await runTwoSteps("streamText", { scenario: "flakyStop", mode }),
      ).toMatchObject({
        steps: 1,
        usageCalls: 1,
        error: null,
        saved: [USER, ...LOOKUP_STEP],
        ...stream(streamed, "finished"),
        streamedText: "",
      });
    });

    // The abort wins over a step that completed before the SDK moved on:
    // its content is kept, under the failure (#326).
    test("an abort before the SDK decides to continue fails the first step", async () => {
      expect(
        await runTwoSteps("streamText", {
          scenario: "toolCallsFinish",
          mode,
          abort: "afterFirstStep",
        }),
      ).toMatchObject({
        usageCalls: 1,
        error: null,
        saved: [USER, ...LOOKUP_STEP.map((m) => ({ ...m, status: "failed" }))],
        ...stream(streamed, "aborted"),
      });
    });

    test("a throwing prepareStep keeps the step before it", async () => {
      expect(
        await runTwoSteps("streamText", {
          scenario: "toolCallsFinish",
          mode,
          prepareStepThrows: true,
        }),
      ).toMatchObject({
        usageCalls: 1,
        saved: [USER, ...LOOKUP_STEP, FAILED_TAIL],
        ...stream(streamed, "aborted"),
      });
    });

    test("a provider error in the final step fails it and keeps the first", async () => {
      expect(
        await runTwoSteps("streamText", {
          scenario: "toolCallsFinish",
          mode,
          failure: "finalStep",
        }),
      ).toMatchObject({
        usageCalls: 2,
        saved: [USER, ...LOOKUP_STEP, { ...FAILED_TAIL, parts: ["text"] }],
        ...stream(streamed, "aborted"),
      });
    });

    test.each([
      { step: "first", failUsageOn: 1 },
      { step: "final", failUsageOn: 2 },
    ])(
      "a usage handler failing on the $step step saves every step once",
      async ({ failUsageOn }) => {
        expect(
          await runTwoSteps("streamText", {
            scenario: "toolCallsFinish",
            mode,
            failUsageOn,
          }),
        ).toMatchObject({
          usageCalls: 2,
          error: mode === "awaited" ? "usage handler failed" : null,
          saved: [USER, ...LOOKUP_STEP, ANSWER],
          ...stream(streamed, "finished"),
        });
      },
    );
    test.each([
      { retry: "automatic", streamRetries: 1, callerRequestsRetry: false },
      { retry: "onError", streamRetries: 0, callerRequestsRetry: true },
    ])(
      "a stream retry ($retry) is not a failure",
      async ({ streamRetries, callerRequestsRetry }) => {
        expect(
          await runTwoSteps("streamText", {
            scenario: "toolCallsFinish",
            mode,
            failure: "finalStepOnce",
            streamRetries,
            callerRequestsRetry,
          }),
        ).toMatchObject({
          steps: 2,
          usageCalls: 2,
          error: null,
          callerOnErrorCalls: 1,
          saved: [USER, ...LOOKUP_STEP, ANSWER],
          ...stream(streamed, "finished"),
        });
      },
    );

    // Issue #387: aborting the signal the AI SDK still uses, from inside
    // its onError, surfaced as an unhandled AbortError.
    test("a provider failure before the first chunk fails the message without aborting the SDK", async () => {
      expect(
        await runTwoSteps("streamText", {
          scenario: "toolCallsFinish",
          mode,
          failure: "beforeFirstChunk",
        }),
      ).toMatchObject({
        steps: null,
        usageCalls: 0,
        error: null,
        callerOnErrorCalls: 1,
        signalAbortedInCallerOnError: false,
        saved: [USER, FAILED_TAIL],
      });
    });

    // The AI SDK ignores a throwing callback (its notify), and so do we.
    test.each(["onStepEnd", "onEnd"] as const)(
      "a throwing caller %s is ignored and does not affect what is saved",
      async (callerThrows) => {
        expect(
          await runTwoSteps("streamText", {
            scenario: "toolCallsFinish",
            mode,
            callerThrows,
          }),
        ).toMatchObject({
          steps: 2,
          usageCalls: 2,
          error: null,
          saved: [USER, ...LOOKUP_STEP, ANSWER],
          ...stream(streamed, "finished"),
        });
      },
    );

    test("a throwing caller onError still fails the generation", async () => {
      expect(
        await runTwoSteps("streamText", {
          scenario: "toolCallsFinish",
          mode,
          failure: "finalStep",
          callerThrows: "onError",
        }),
      ).toMatchObject({
        callerOnErrorCalls: 1,
        saved: [USER, ...LOOKUP_STEP, { ...FAILED_TAIL, parts: ["text"] }],
        ...stream(streamed, "aborted"),
      });
    });

    test("a final save failing before it stores anything fails the generation", async () => {
      expect(
        await runTwoSteps("streamText", {
          scenario: "toolCallsFinish",
          mode,
          failStore: "final",
        }),
      ).toMatchObject({
        error: mode === "awaited" ? "final store failed" : null,
        saved: [
          USER,
          ...LOOKUP_STEP,
          { ...FAILED_TAIL, parts: streamed ? ["text"] : [] },
        ],
        ...stream(streamed, "aborted"),
      });
    });

    test("a transient final save failure keeps the answer under the failure", async () => {
      expect(
        await runTwoSteps("streamText", {
          scenario: "toolCallsFinish",
          mode,
          failStore: "finalOnce",
        }),
      ).toMatchObject({
        usageCalls: 2,
        error: mode === "awaited" ? "final store failed" : null,
        saved: [USER, ...LOOKUP_STEP, { ...FAILED_TAIL, parts: ["text"] }],
        ...stream(streamed, "aborted"),
      });
    });

    test("a failure to fail the message still keeps the step under it", async () => {
      expect(
        await runTwoSteps("streamText", {
          scenario: "toolCallsFinish",
          mode,
          failStore: "finalOnce",
          failMessageFailure: true,
        }),
      ).toMatchObject({
        usageCalls: 2,
        error: mode === "awaited" ? "final store failed" : null,
        saved: [USER, ...LOOKUP_STEP, ANSWER],
        ...stream(streamed, "aborted"),
      });
    });

    // The AI SDK owns that signal: only a cancellation may abort it, never
    // the cleanup of a failure (issue #387).
    test.each([
      {
        name: "a provider failure before the first chunk",
        args: { failure: "beforeFirstChunk" },
      },
      {
        name: "a provider error in a later step",
        args: { failure: "finalStep" },
      },
      { name: "a throwing prepareStep", args: { prepareStepThrows: true } },
      { name: "a failed final save", args: { failStore: "final" } },
    ] as const)("$name leaves the SDK's signal alone", async ({ args }) => {
      expect(
        await runTwoSteps("streamText", {
          scenario: "toolCallsFinish",
          mode,
          ...args,
        }),
      ).toMatchObject({ signalAborted: false });
    });

    test("a caller abort still aborts the SDK's signal", async () => {
      expect(
        await runTwoSteps("streamText", {
          scenario: "toolCallsFinish",
          mode,
          abort: "duringSecondStep",
        }),
      ).toMatchObject({ signalAborted: true });
    });

    test("a step that fails to save stops the generation instead of being skipped", async () => {
      const run = await runTwoSteps("streamText", {
        scenario: "toolCallsFinish",
        mode,
        failStore: "first",
      });
      expect(run).toMatchObject({
        steps: mode === "awaited" ? null : 1,
        error: mode === "awaited" ? "first store failed" : null,
        ...stream(streamed, "aborted"),
      });
      expect(run.saved[0]).toEqual(USER);
      expect(run.saved.slice(1).map((m) => m.status)).toEqual(
        run.saved.slice(1).map(() => "failed"),
      );
      expect(run.saved.length).toBeGreaterThan(1);
    });
  },
);

describe.each([
  { fn: "streamText", mode: "awaited" },
  { fn: "streamText", mode: "returnImmediately" },
  { fn: "streamText", mode: "noDeltas" },
  { fn: "generateText", mode: "noDeltas" },
] as const)("the caller's onEnd, $fn $mode (issue #388)", ({ fn, mode }) => {
  test("runs after the final step is saved", async () => {
    const { atCallerOnEnd } = await runTwoSteps(fn, {
      scenario: "toolCallsFinish",
      mode,
    });
    expect(atCallerOnEnd).toEqual([USER, ...LOOKUP_STEP, ANSWER]);
  });
});

describe("generateText saves every step the SDK runs (issue #388)", () => {
  test.each([
    { scenario: "toolCallsFinish", firstStep: LOOKUP_STEP },
    { scenario: "deniedApproval", firstStep: DENIED_STEP },
    { scenario: "stopFinish", firstStep: LOOKUP_STEP },
  ] as const)("$scenario", async ({ scenario, firstStep }) => {
    expect(
      await runTwoSteps("generateText", { scenario, mode: "noDeltas" }),
    ).toMatchObject({
      steps: 2,
      usageCalls: 2,
      error: null,
      duringSecondStep: [USER, ...firstStep, PLACEHOLDER],
      saved: [USER, ...firstStep, ANSWER],
    });
  });

  test.each([
    { name: "an abort", args: { abort: "duringSecondStep" } },
    { name: "a provider error", args: { failure: "finalStep" } },
    { name: "a throwing prepareStep", args: { prepareStepThrows: true } },
  ] as const)(
    "$name in the second step keeps the first and fails the second",
    async ({ args }) => {
      expect(
        await runTwoSteps("generateText", {
          scenario: "toolCallsFinish",
          mode: "noDeltas",
          ...args,
        }),
      ).toMatchObject({
        steps: null,
        usageCalls: 1,
        error: expect.any(String),
        saved: [USER, ...LOOKUP_STEP, FAILED_TAIL],
      });
    },
  );

  test.each([
    { step: "first", failUsageOn: 1 },
    { step: "final", failUsageOn: 2 },
  ])(
    "a usage handler failing on the $step step saves every step once",
    async ({ failUsageOn }) => {
      expect(
        await runTwoSteps("generateText", {
          scenario: "toolCallsFinish",
          mode: "noDeltas",
          failUsageOn,
        }),
      ).toMatchObject({
        usageCalls: 2,
        error: "usage handler failed",
        saved: [USER, ...LOOKUP_STEP, ANSWER],
      });
    },
  );

  test.each([
    { name: "a provider error", args: { failure: "finalStep" } },
    { name: "a throwing prepareStep", args: { prepareStepThrows: true } },
    { name: "a failed final save", args: { failStore: "final" } },
    { name: "a caller abort", args: { abort: "duringSecondStep" } },
  ] as const)(
    "$name aborts the SDK's signal only when it is a cancellation",
    async ({ name, args }) => {
      expect(
        await runTwoSteps("generateText", {
          scenario: "toolCallsFinish",
          mode: "noDeltas",
          ...args,
        }),
      ).toMatchObject({ signalAborted: name === "a caller abort" });
    },
  );

  test("a step that fails to save stops the generation instead of being skipped", async () => {
    const run = await runTwoSteps("generateText", {
      scenario: "toolCallsFinish",
      mode: "noDeltas",
      failStore: "first",
    });
    expect(run).toMatchObject({ steps: null, error: "first store failed" });
    expect(run.saved).toEqual([USER, FAILED_TAIL]);
  });

  test.each(["onStepEnd", "onEnd"] as const)(
    "a throwing caller %s is ignored and does not affect what is saved",
    async (callerThrows) => {
      expect(
        await runTwoSteps("generateText", {
          scenario: "toolCallsFinish",
          mode: "noDeltas",
          callerThrows,
        }),
      ).toMatchObject({
        steps: 2,
        usageCalls: 2,
        error: null,
        saved: [USER, ...LOOKUP_STEP, ANSWER],
      });
    },
  );

  test("a transient final save failure keeps the answer under the failure", async () => {
    expect(
      await runTwoSteps("generateText", {
        scenario: "toolCallsFinish",
        mode: "noDeltas",
        failStore: "finalOnce",
      }),
    ).toMatchObject({
      steps: null,
      usageCalls: 2,
      error: "final store failed",
      saved: [USER, ...LOOKUP_STEP, { ...FAILED_TAIL, parts: ["text"] }],
    });
  });

  test("a failure to fail the message still keeps the step under it", async () => {
    expect(
      await runTwoSteps("generateText", {
        scenario: "toolCallsFinish",
        mode: "noDeltas",
        failStore: "finalOnce",
        failMessageFailure: true,
      }),
    ).toMatchObject({
      usageCalls: 2,
      error: "failing the message failed",
      saved: [USER, ...LOOKUP_STEP, ANSWER],
    });
  });

  test("only the SDK consults stop conditions", async () => {
    expect(
      await runTwoSteps("generateText", {
        scenario: "flakyStop",
        mode: "noDeltas",
      }),
    ).toMatchObject({
      steps: 1,
      usageCalls: 1,
      error: null,
      saved: [USER, ...LOOKUP_STEP],
    });
  });
});
