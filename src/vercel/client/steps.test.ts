import { describe, expect, test } from "vitest";
import { v, type ObjectType } from "convex/values";
import { isStepCount } from "ai";
import { z } from "zod/v4";
import { APICallError } from "@ai-sdk/provider";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import type { ActionCtx } from "./types.js";
import type { MessageDoc } from "../../validators.js";
import { Agent, createThread, createTool } from "../index.js";
import { app, components } from "./setup.test.js";
import { mockModel } from "./mockModel.js";
import { errorToString } from "./utils.js";

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const CALL = {
  type: "tool-call",
  toolCallId: "tc-lookup",
  toolName: "lookup",
  input: "{}",
} as const;

// The SDK continues past a tool call or a denied approval whatever the first
// step's finish reason says (#388). The first `rejections` requests are
// rejected before anything streams, retryably and without a backoff.
function model(
  firstFinish: "tool-calls" | "stop",
  failSecond: boolean,
  stopAfterError = false,
  rejections = 0,
  failFirst = false,
) {
  const first: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    CALL,
    ...(failFirst
      ? [{ type: "error", error: "provider failed" } as const]
      : []),
    {
      type: "finish",
      finishReason: { unified: firstFinish, raw: undefined },
      usage: USAGE,
    },
  ];
  const second: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "Looked it up" },
    { type: "text-end", id: "t" },
    ...(failSecond
      ? [{ type: "error", error: "provider failed" } as const]
      : []),
    {
      type: "finish",
      finishReason: {
        unified: failSecond && !stopAfterError ? "error" : "stop",
        raw: undefined,
      },
      usage: USAGE,
    },
  ];
  let calls = 0;
  const call = () => {
    if (calls++ < rejections) {
      throw new APICallError({
        message: "provider rejected",
        url: "mock",
        requestBodyValues: {},
        isRetryable: true,
        responseHeaders: { "retry-after-ms": "0" },
      });
    }
    return calls - rejections - 1;
  };
  // As a provider's request would, a call fails once its signal aborts.
  const m = mockModel({
    doStream: async ({ abortSignal }) => {
      abortSignal?.throwIfAborted();
      return {
        stream: simulateReadableStream({ chunks: call() ? second : first }),
      };
    },
    doGenerate: async ({ abortSignal }) => {
      abortSignal?.throwIfAborted();
      if (call() === 0) {
        return {
          content: [CALL],
          finishReason: { unified: firstFinish, raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      }
      if (failSecond) throw new Error("provider failed");
      return {
        content: [{ type: "text", text: "Looked it up" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },
  });
  return { model: m, calls: () => calls };
}

// The first attempt fails partway through, and the SDK's stream retry
// answers.
function retriedModel() {
  let calls = 0;
  const m = mockModel({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: (calls++
          ? [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "Recovered" },
              { type: "text-end", id: "t" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: USAGE,
              },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "Partial" },
              { type: "error", error: "provider failed" },
            ]) as LanguageModelV4StreamPart[],
      }),
    }),
  });
  return { model: m, calls: () => calls };
}

type Row = { role?: string; parts: string[]; status: string; error?: string };

async function readThread(ctx: ActionCtx, threadId: string) {
  const page = await ctx.runQuery(
    components.agent.messages.listMessagesByThreadId,
    {
      threadId,
      order: "asc",
      paginationOpts: { cursor: null, numItems: 50 },
    },
  );
  return (page.page as MessageDoc[]).map(
    (m): Row => ({
      role: m.message?.role,
      parts:
        typeof m.message?.content === "string"
          ? ["text"]
          : (m.message?.content ?? []).map((p) => p.type),
      status: m.status,
      ...(m.error !== undefined ? { error: m.error } : {}),
    }),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const runArgs = {
  threadId: v.string(),
  runner: v.union(
    v.literal("generateText"),
    v.literal("streamText"),
    v.literal("returnImmediately"),
    v.literal("noDeltas"),
  ),
  scenario: v.union(
    v.literal("toolCalls"),
    v.literal("stopWithToolCall"),
    v.literal("deniedApproval"),
    v.literal("toolError"),
    v.literal("approvalRequest"),
  ),
  // Throws on the save that stores the assistant tool call, or the answer.
  failSave: v.optional(v.union(v.literal("first"), v.literal("final"))),
  // That save commits before it throws.
  failSaveAfterCommit: v.optional(v.boolean()),
  // Throws on the delta write that carries the first step's tool result.
  failToolResultDelta: v.optional(v.boolean()),
  abortInTool: v.optional(v.boolean()),
  failFirst: v.optional(v.boolean()),
  failSecond: v.optional(v.boolean()),
  stopAfterError: v.optional(v.boolean()),
  // When a retry from the same prompt starts.
  restartAt: v.optional(
    v.union(
      v.literal("duringFirstStep"),
      v.literal("afterFirstStep"),
      v.literal("beforeAnswer"),
    ),
  ),
  deletePromptAt: v.optional(
    v.union(v.literal("duringFirstStep"), v.literal("beforeAnswer")),
  ),
  abortBeforeStepEnd: v.optional(v.boolean()),
  stopFromStepEnd: v.optional(v.boolean()),
  stopOnUsage: v.optional(v.boolean()),
  stopWhenThrows: v.optional(v.boolean()),
  abortInStepEnd: v.optional(v.boolean()),
  abortDuringSave: v.optional(v.boolean()),
  awaitTextOnly: v.optional(v.boolean()),
  // Reads fullStream and then text, as a caller would.
  readStream: v.optional(v.boolean()),
  retryFirstAttempt: v.optional(v.boolean()),
  stopAtAnswer: v.optional(v.boolean()),
  rejectRequests: v.optional(v.number()),
  maxRetries: v.optional(v.number()),
  throwAtFinish: v.optional(v.boolean()),
  abortOnCreate: v.optional(v.boolean()),
  slowFailure: v.optional(v.boolean()),
  saveAll: v.optional(v.boolean()),
  // Passes the deprecated onStepFinish and onFinish instead.
  deprecatedCallbacks: v.optional(v.boolean()),
};
type RunArgs = Omit<ObjectType<typeof runArgs>, "threadId">;

const run = app.action({
  args: runArgs,
  handler: async (ctx, args) => {
    const m = args.retryFirstAttempt
      ? retriedModel()
      : model(
          args.scenario === "toolCalls" || args.scenario === "toolError"
            ? "tool-calls"
            : "stop",
          args.failSecond ?? false,
          args.stopAfterError,
          args.rejectRequests,
          args.failFirst,
        );
    const firstMessageId = async () => {
      const { page } = await ctx.runQuery(
        components.agent.messages.listMessagesByThreadId,
        {
          threadId: args.threadId,
          order: "asc",
          paginationOpts: { cursor: null, numItems: 1 },
        },
      );
      return (page[0] as MessageDoc)._id;
    };
    // What a retry from the same prompt does.
    const restart = async () => {
      await ctx.runMutation(components.agent.messages.addMessages, {
        threadId: args.threadId,
        promptMessageId: await firstMessageId(),
        failPendingSteps: true,
        messages: [
          { message: { role: "assistant", content: [] }, status: "pending" },
        ],
      });
    };
    const deletePrompt = async () => {
      await ctx.runMutation(components.agent.messages.deleteByIds, {
        messageIds: [await firstMessageId()],
      });
    };
    let usageCalls = 0;
    let stepEnds = 0;
    let endCalls = 0;
    let savedAtEnd: Row[] | undefined;
    let stopRequested = false;
    const abort = new AbortController();
    let duringSecondStep: Row[] | undefined;
    let streamsAtAnswerSave: string[] | undefined;
    const agent = new Agent(components.agent, {
      name: "steps",
      languageModel: m.model,
      tools: {
        lookup: createTool({
          inputSchema: z.object({}),
          needsApproval: args.scenario === "approvalRequest",
          execute: async () => {
            if (args.restartAt === "duringFirstStep") await restart();
            if (args.deletePromptAt === "duringFirstStep") await deletePrompt();
            if (args.scenario === "toolError") throw new Error("lookup failed");
            if (args.abortInTool) abort.abort("Stopped");
            return { ok: true };
          },
        }),
      },
      usageHandler: async () => {
        usageCalls++;
      },
    });
    const onStepEnd = async () => {
      stepEnds++;
      if (args.restartAt === "afterFirstStep" && stepEnds === 1) {
        await restart();
      }
      stopRequested = !!args.stopFromStepEnd;
      if (args.abortInStepEnd) abort.abort("Stopped");
    };
    const onEnd = async () => {
      endCalls++;
      savedAtEnd = await readThread(ctx, args.threadId);
    };
    const onErrors: string[] = [];
    const callArgs = {
      prompt: "Go.",
      ...(args.readStream
        ? {
            onError: ({ error }: { error: unknown }) => {
              onErrors.push(errorToString(error));
            },
          }
        : {}),
      stopWhen: [
        isStepCount(5),
        () => {
          if (args.stopWhenThrows) throw new Error("stopWhen failed");
          return stopRequested || (!!args.stopOnUsage && usageCalls > 0);
        },
      ],
      maxRetries: args.maxRetries ?? 0,
      ...(args.retryFirstAttempt ? { streamRetries: 1 } : {}),
      ...(args.throwAtFinish
        ? {
            experimental_transform: <Part extends { type: string }>() =>
              new TransformStream<Part, Part>({
                transform(part, controller) {
                  if (part.type === "finish") {
                    throw new Error("transform failed");
                  }
                  controller.enqueue(part);
                },
              }),
          }
        : {}),
      ...(args.stopAtAnswer
        ? {
            experimental_transform: <Part extends { type: string }>({
              stopStream,
            }: {
              stopStream: () => void;
            }) =>
              new TransformStream<Part, Part>({
                transform(part, controller) {
                  if (part.type === "text-delta") stopStream();
                  else controller.enqueue(part);
                },
              }),
          }
        : {}),
      ...(args.abortBeforeStepEnd
        ? {
            // The abort fails the generation before the SDK reaches the
            // first step's onStepEnd.
            onChunk: async ({ chunk }: { chunk: { type: string } }) => {
              if (chunk.type !== "finish-step") return;
              await sleep(50);
              abort.abort("Stopped");
              await sleep(100);
            },
          }
        : {}),
      abortSignal: abort.signal,
      ...(args.scenario === "deniedApproval"
        ? { toolApproval: () => ({ type: "denied" as const, reason: "No." }) }
        : {}),
      prepareStep: async ({ stepNumber }: { stepNumber: number }) => {
        if (stepNumber === 1) {
          duringSecondStep = await readThread(ctx, args.threadId);
          if (args.restartAt === "beforeAnswer") await restart();
          if (args.deletePromptAt === "beforeAnswer") await deletePrompt();
        }
        return undefined;
      },
      ...(args.deprecatedCallbacks
        ? { onStepFinish: onStepEnd, onFinish: onEnd }
        : { onStepEnd, onEnd }),
    };
    const saves = (args: unknown, part: string) =>
      (args as { messages?: MessageDoc[] }).messages?.some(
        (m) =>
          m.message?.role === "assistant" &&
          Array.isArray(m.message.content) &&
          m.message.content.some((p) => p.type === part),
      ) ?? false;
    const intercepted: ActionCtx = {
      ...ctx,
      runMutation: (async (reference, mutationArgs) => {
        const failsSave =
          args.failSave &&
          saves(mutationArgs, args.failSave === "first" ? "tool-call" : "text");
        if (failsSave && !args.failSaveAfterCommit) {
          throw new Error(`${args.failSave} save failed`);
        }
        if (
          args.failToolResultDelta &&
          (mutationArgs as { parts?: { type: string }[] }).parts?.some(
            (p) => p.type === "tool-output-available",
          )
        ) {
          throw new Error("delta failed");
        }
        // Slower than the harness waits after the generation returns.
        if (
          args.abortInStepEnd ||
          (args.awaitTextOnly && saves(mutationArgs, "text")) ||
          (args.slowFailure && "result" in (mutationArgs as object))
        ) {
          await sleep(100);
        }
        const result = await ctx.runMutation(reference, mutationArgs);
        if (failsSave) throw new Error(`${args.failSave} save failed`);
        const { pendingMessageId, format } = mutationArgs as {
          pendingMessageId?: string;
          format?: string;
        };
        // Aborts once a step save has committed, before its reply arrives.
        if (args.abortDuringSave && pendingMessageId) {
          abort.abort("Stopped");
          await sleep(100);
        }
        // Someone else aborts the stream as soon as it is created, before
        // the creation's reply arrives.
        if (args.abortOnCreate && format !== undefined) {
          await ctx.runMutation(components.agent.streams.abort, {
            streamId: result as string,
            reason: "Stopped elsewhere",
          });
          await sleep(50);
        }
        if (saves(mutationArgs, "text")) {
          const streams = await ctx.runQuery(components.agent.streams.list, {
            threadId: args.threadId,
            statuses: ["streaming", "finished", "aborted"],
          });
          streamsAtAnswerSave = streams.map((s) => s.status);
        }
        return result;
      }) as ActionCtx["runMutation"],
    };
    const threadArgs = { threadId: args.threadId };
    const options = args.saveAll
      ? { storageOptions: { saveMessages: "all" as const } }
      : {};
    let error: string | null = null;
    let seen:
      | { errorParts: string[]; thrown: string | null; text: string }
      | undefined;
    try {
      if (args.runner === "generateText") {
        await agent.generateText(intercepted, threadArgs, callArgs, options);
      } else {
        const result = await agent.streamText(
          intercepted,
          threadArgs,
          callArgs,
          args.runner === "noDeltas"
            ? options
            : {
                ...options,
                saveStreamDeltas: {
                  throttleMs: 0,
                  returnImmediately: args.runner === "returnImmediately",
                },
              },
        );
        if (args.readStream) {
          seen = { errorParts: [], thrown: null, text: "" };
          try {
            for await (const part of result.fullStream) {
              if (part.type === "error") {
                seen.errorParts.push(errorToString(part.error));
              }
            }
          } catch (e) {
            seen.thrown = errorToString(e);
          }
          seen.text = await result.text.then(
            (text) => `resolved: ${text}`,
            (e) => `rejected: ${errorToString(e)}`,
          );
        } else if (args.awaitTextOnly) await result.text;
        else await result.consumeStream();
      }
    } catch (e) {
      error = errorToString(e);
    }
    // Let a returnImmediately generation's own cleanup land.
    if (!args.awaitTextOnly) await sleep(50);
    const streams = await ctx.runQuery(components.agent.streams.list, {
      threadId: args.threadId,
      statuses: ["streaming", "finished", "aborted"],
    });
    return {
      error,
      usageCalls,
      stepEnds,
      endCalls,
      modelCalls: m.calls(),
      duringSecondStep: duringSecondStep ?? null,
      saved: await readThread(ctx, args.threadId),
      savedAtEnd: savedAtEnd ?? null,
      streams: streams.map((s) => s.status),
      streamsAtAnswerSave: streamsAtAnswerSave ?? null,
      ...(seen ? { seen: { ...seen, onErrors } } : {}),
    };
  },
});

const { api, createTest } = app.defineModules({ steps: { run } });

async function go(args: RunArgs) {
  const t = createTest();
  const threadId = await t.run((ctx) =>
    createThread(ctx, components.agent, {}),
  );
  return t.action(api.steps.run, { threadId, ...args });
}

const USER: Row = { role: "user", parts: ["text"], status: "success" };
const PENDING: Row = { role: "assistant", parts: [], status: "pending" };
const EMPTY: Row = { role: "assistant", parts: [], status: "success" };
const ANSWER: Row = { role: "assistant", parts: ["text"], status: "success" };
const LOOKUP: Row[] = [
  { role: "assistant", parts: ["tool-call"], status: "success" },
  { role: "tool", parts: ["tool-result"], status: "success" },
];
const DENIED: Row[] = [
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
const failed = (row: Row, error: string): Row => ({
  ...row,
  status: "failed",
  error,
});

const runners = [
  { runner: "generateText", streamed: false, awaited: true },
  { runner: "streamText", streamed: true, awaited: true },
  { runner: "returnImmediately", streamed: true, awaited: false },
  { runner: "noDeltas", streamed: false, awaited: false },
] as const;

describe.each(runners)("$runner", ({ runner, streamed, awaited }) => {
  test.each([
    { scenario: "toolCalls", first: LOOKUP },
    { scenario: "stopWithToolCall", first: LOOKUP },
    { scenario: "deniedApproval", first: DENIED },
    { scenario: "toolError", first: LOOKUP },
  ] as const)(
    "saves every step the SDK runs: $scenario (#388)",
    async ({ scenario, first }) => {
      const saved = [USER, ...first, ANSWER];
      expect(await go({ runner, scenario })).toEqual({
        error: null,
        usageCalls: 2,
        stepEnds: 2,
        endCalls: 1,
        modelCalls: 2,
        duringSecondStep: [USER, ...first, PENDING],
        saved,
        savedAtEnd: saved,
        streams: streamed ? ["finished"] : [],
        streamsAtAnswerSave: streamed ? ["finished"] : [],
      });
    },
  );

  test("the deprecated callbacks run as onStepEnd and onEnd do", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      deprecatedCallbacks: true,
    });
    expect(r.stepEnds).toBe(2);
    expect(r.endCalls).toBe(1);
    expect(r.savedAtEnd).toEqual([USER, ...LOOKUP, ANSWER]);
  });

  test("saveMessages all saves every step", async () => {
    const r = await go({ runner, scenario: "toolCalls", saveAll: true });
    expect(r.saved).toEqual([USER, ...LOOKUP, ANSWER]);
    expect(r.streams).toEqual(streamed ? ["finished"] : []);
  });

  test("a tool approval request ends the generation without a pending message", async () => {
    const r = await go({ runner, scenario: "approvalRequest" });
    expect(r.modelCalls).toBe(1);
    expect(r.saved).toEqual([
      USER,
      {
        role: "assistant",
        parts: ["tool-call", "tool-approval-request"],
        status: "success",
      },
    ]);
    expect(r.streams).toEqual(streamed ? ["finished"] : []);
  });

  test("a failed step save stops the generation (#419)", async () => {
    const r = await go({ runner, scenario: "toolCalls", failSave: "first" });
    expect(r.modelCalls).toBe(1);
    // On main the save ran first, and its failure skipped the caller's
    // onStepEnd.
    expect(r.stepEnds).toBe(1);
    expect(r.endCalls).toBe(0);
    // A streamed step's parts are recovered into the failed message.
    expect(r.saved).toEqual(
      streamed
        ? [USER, ...LOOKUP.map((row) => failed(row, "first save failed"))]
        : [USER, failed(EMPTY, "first save failed")],
    );
    if (awaited) expect(r.error).toBe("first save failed");
    expect(r.streams).toEqual(streamed ? ["aborted"] : []);
  });

  test("a step save that commits and then fails fails the pending message it made", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      failSave: "first",
      failSaveAfterCommit: true,
    });
    expect(r.modelCalls).toBe(1);
    expect(r.saved).toEqual([
      USER,
      ...LOOKUP,
      failed(EMPTY, "first save failed"),
    ]);
    if (awaited) expect(r.error).toBe("first save failed");
    expect(r.streams).toEqual(streamed ? ["aborted"] : []);
  });

  test("a final save that commits and then fails leaves nothing pending", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      failSave: "final",
      failSaveAfterCommit: true,
    });
    expect(r.saved).toEqual([USER, ...LOOKUP, ANSWER]);
    if (awaited) expect(r.error).toBe("final save failed");
  });

  test.runIf(runner === "generateText")(
    "an abort while a step's tool runs keeps the step and rejects",
    async () => {
      const r = await go({ runner, scenario: "toolCalls", abortInTool: true });
      expect(r.error).toBe("Stopped");
      expect(r.modelCalls).toBe(1);
      expect(r.saved).toEqual([USER, ...LOOKUP, failed(EMPTY, "Stopped")]);
    },
  );

  test.runIf(streamed)(
    "a delta write that fails after a tool ran keeps its step, and the result rejects",
    async () => {
      const r = await go({
        runner,
        scenario: "toolCalls",
        failToolResultDelta: true,
        readStream: true,
      });
      expect(r.modelCalls).toBe(1);
      expect(r.seen?.text).toMatch(/^rejected: /);
      expect(r.saved).toEqual([USER, ...LOOKUP, failed(EMPTY, "delta failed")]);
      expect(r.streams).toEqual(["aborted"]);
    },
  );

  // An awaited generation rejects with it instead, as above.
  test.skipIf(awaited)(
    "a failed step save reaches the stream once, as an error part (#419)",
    async () => {
      const r = await go({
        runner,
        scenario: "toolCalls",
        failSave: "first",
        readStream: true,
      });
      // As after any error the SDK streams, the text is the finished steps'.
      expect(r.seen).toEqual({
        errorParts: ["first save failed"],
        onErrors: ["first save failed"],
        thrown: null,
        text: "resolved: ",
      });
    },
  );

  test("a failed final save fails the generation (#419)", async () => {
    const r = await go({ runner, scenario: "toolCalls", failSave: "final" });
    expect(r.saved).toEqual([
      USER,
      ...LOOKUP,
      failed(streamed ? ANSWER : EMPTY, "final save failed"),
    ]);
    if (awaited) expect(r.error).toBe("final save failed");
    expect(r.endCalls).toBe(0);
    expect(r.streams).toEqual(streamed ? ["aborted"] : []);
  });

  test("a provider error in the second step keeps the first and aborts the stream", async () => {
    const r = await go({ runner, scenario: "toolCalls", failSecond: true });
    // streamText keeps the partial text, and its usage, from the errored step.
    expect(r.saved).toEqual([
      USER,
      ...LOOKUP,
      failed(runner === "generateText" ? EMPTY : ANSWER, "provider failed"),
    ]);
    expect(r.usageCalls).toBe(runner === "generateText" ? 1 : 2);
    expect(r.streams).toEqual(streamed ? ["aborted"] : []);
  });

  test.skipIf(runner === "generateText")(
    "a provider error in a step the SDK would continue past stops it there",
    async () => {
      const r = await go({ runner, scenario: "toolCalls", failFirst: true });
      expect(r.modelCalls).toBe(1);
      expect(r.saved).toEqual([
        USER,
        ...LOOKUP.map((row) => failed(row, "provider failed")),
      ]);
      expect(r.error).toBe(null);
      expect(r.streams).toEqual(streamed ? ["aborted"] : []);
    },
  );

  test.skipIf(runner === "generateText")(
    "a provider error before a normal finish fails the answer",
    async () => {
      const r = await go({
        runner,
        scenario: "toolCalls",
        failSecond: true,
        stopAfterError: true,
      });
      expect(r.saved).toEqual([
        USER,
        ...LOOKUP,
        failed(ANSWER, "provider failed"),
      ]);
      expect(r.streams).toEqual(streamed ? ["aborted"] : []);
    },
  );

  test("a rejected request fails the generation", async () => {
    const r = await go({ runner, scenario: "toolCalls", rejectRequests: 10 });
    expect(r.saved).toEqual([USER, failed(EMPTY, "provider rejected")]);
    expect(r.streams).toEqual(streamed ? ["aborted"] : []);
    if (runner === "generateText") expect(r.error).toBe("provider rejected");
  });

  test("a rejected request is failed before the result rejects", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      rejectRequests: 10,
      awaitTextOnly: true,
      slowFailure: true,
    });
    expect(r.saved).toEqual([USER, failed(EMPTY, "provider rejected")]);
  });

  test("a request the SDK retries saves every step", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      rejectRequests: 1,
      maxRetries: 1,
    });
    expect(r.modelCalls).toBe(3);
    expect(r.saved).toEqual([USER, ...LOOKUP, ANSWER]);
    expect(r.streams).toEqual(streamed ? ["finished"] : []);
  });

  test("stopWhen sees what onStepEnd set", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      stopFromStepEnd: true,
    });
    expect(r.modelCalls).toBe(1);
    expect(r.saved).toEqual([USER, ...LOOKUP]);
  });

  test("stopWhen sees the usage of the step it follows", async () => {
    const r = await go({ runner, scenario: "toolCalls", stopOnUsage: true });
    expect(r.modelCalls).toBe(1);
    expect(r.saved).toEqual([USER, ...LOOKUP]);
  });

  test("a failure between steps keeps the step the SDK finished", async () => {
    const r = await go({ runner, scenario: "toolCalls", stopWhenThrows: true });
    expect(r.modelCalls).toBe(1);
    expect(r.saved).toEqual([
      USER,
      ...LOOKUP,
      failed(EMPTY, "stopWhen failed"),
    ]);
    if (awaited) expect(r.error).toBe("stopWhen failed");
  });

  // generateText's last step has ended, so the AI SDK resolves it; a stream is
  // still open, so the AI SDK reports the abort there.
  const aborts = runner !== "generateText";
  test.each([
    {
      failSave: undefined,
      saved: [USER, ...LOOKUP, ...(aborts ? [failed(EMPTY, "Stopped")] : [])],
      error: null,
    },
    {
      failSave: "first",
      saved: [USER, failed(EMPTY, aborts ? "Stopped" : "first save failed")],
      error: "first save failed",
    },
  ] as const)(
    "an abort in onStepEnd saves the step first, or reports its failed save: $failSave",
    async ({ failSave, saved, error }) => {
      const r = await go({
        runner,
        scenario: "toolCalls",
        stopFromStepEnd: true,
        abortInStepEnd: true,
        failSave,
      });
      expect(r.saved).toEqual(saved);
      if (awaited) expect(r.error).toBe(error);
    },
  );

  test("an abort during a step save fails the next step", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      abortDuringSave: true,
    });
    expect(r.modelCalls).toBe(1);
    expect(r.saved).toEqual([USER, ...LOOKUP, failed(EMPTY, "Stopped")]);
  });

  test("the answer is saved before the result resolves", async () => {
    const r = await go({ runner, scenario: "toolCalls", awaitTextOnly: true });
    expect(r.saved).toEqual([USER, ...LOOKUP, ANSWER]);
  });

  test("the answer's save finishes its stream (#181)", async () => {
    const r = await go({ runner, scenario: "toolCalls" });
    expect(r.streamsAtAnswerSave).toEqual(streamed ? ["finished"] : []);
  });

  test.skipIf(!streamed)(
    "a stream aborted while it is being created ends aborted, with nothing pending",
    async () => {
      const r = await go({
        runner,
        scenario: "toolCalls",
        abortOnCreate: true,
      });
      expect(r.saved).not.toContainEqual(PENDING);
      expect(r.streams).toEqual(["aborted"]);
    },
  );

  test("the result rejects when the answer fails to save", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      failSave: "final",
      awaitTextOnly: true,
    });
    expect(r.error).toBe("final save failed");
  });

  test.skipIf(runner === "generateText")(
    "a stream retry after a provider error saves the answer (#428)",
    async () => {
      expect(
        await go({ runner, scenario: "toolCalls", retryFirstAttempt: true }),
      ).toMatchObject({
        error: null,
        usageCalls: 1,
        stepEnds: 1,
        modelCalls: 2,
        duringSecondStep: null,
        saved: [USER, ANSWER],
        streams: streamed ? ["finished"] : [],
      });
    },
  );

  test.skipIf(runner === "generateText")(
    "a transform that stops the stream fails the step it cut off before the result resolves",
    async () => {
      const r = await go({
        runner,
        scenario: "toolCalls",
        stopAtAnswer: true,
        awaitTextOnly: true,
        slowFailure: true,
      });
      expect(r.modelCalls).toBe(2);
      // A streamed step's parts are recovered into its message.
      expect(r.saved).toEqual([
        USER,
        ...LOOKUP,
        failed(
          streamed ? ANSWER : EMPTY,
          "The generation stopped before its step ended",
        ),
      ]);
      expect(r.streams).toEqual(streamed ? ["aborted"] : []);
      // The caller stopped it, so nothing rejects.
      expect(r.error).toBe(null);
    },
  );

  test.skipIf(runner === "generateText")(
    "a transform that throws at the end keeps the answer",
    async () => {
      const r = await go({
        runner,
        scenario: "toolCalls",
        throwAtFinish: true,
      });
      expect(r.saved).toEqual([
        USER,
        ...LOOKUP,
        ANSWER,
        failed(EMPTY, "transform failed"),
      ]);
      expect(r.usageCalls).toBe(2);
      if (awaited) expect(r.error).toBe("transform failed");
    },
  );

  test("a retry from the same prompt stops the attempt it replaced", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      restartAt: "duringFirstStep",
    });
    expect(r.modelCalls).toBe(1);
  });

  test.skipIf(runner === "generateText")(
    "an abort before onStepEnd saves the step once",
    async () => {
      const r = await go({
        runner,
        scenario: "toolCalls",
        abortBeforeStepEnd: true,
      });
      expect(
        r.saved.filter((row) => row.parts.includes("tool-result")),
      ).toHaveLength(streamed ? 1 : 0);
      expect(r.modelCalls).toBe(1);
    },
  );

  test("a retry during the answer fails the attempt it replaced", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      restartAt: "beforeAnswer",
    });
    expect(r.saved.filter((row) => row.parts.includes("text"))).toEqual([
      USER,
      failed(ANSWER, "Restarting"),
    ]);
    if (awaited) expect(r.error).toBe("Restarting");
    expect(r.streams).toEqual(streamed ? ["aborted"] : []);
  });

  test("a retry between steps stops the attempt it replaced", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      restartAt: "afterFirstStep",
    });
    expect(r.modelCalls).toBe(1);
    // The step saves after the retry, so it fails like one cut off by it. The
    // retry's own pending message is never filled by this harness.
    expect(r.saved).toEqual([
      USER,
      failed(LOOKUP[0], "Restarting"),
      PENDING,
      failed(LOOKUP[1], "Restarting"),
      failed(EMPTY, "Restarting"),
    ]);
  });

  test("a prompt deleted during a step stops the generation (#300)", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      deletePromptAt: "duringFirstStep",
    });
    expect(r.modelCalls).toBe(1);
    if (awaited) expect(r.error).toBe("The prompt message was deleted");
  });

  test("a prompt deleted before the answer abandons its save (#300)", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      deletePromptAt: "beforeAnswer",
    });
    expect(r.modelCalls).toBe(2);
    expect(r.error).toBe(null);
    // A streamed generation's stream is aborted with its prompt.
    expect(r.saved).toEqual([
      ...LOOKUP,
      streamed ? failed(EMPTY, "async abort") : PENDING,
    ]);
  });
});
