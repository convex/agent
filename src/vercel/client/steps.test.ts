import { describe, expect, test } from "vitest";
import { v, type ObjectType } from "convex/values";
import { isStepCount } from "ai";
import { z } from "zod/v4";
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
// step's finish reason says (#388).
function model(
  firstFinish: "tool-calls" | "stop",
  { failFirst = false, failSecond = false } = {},
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
      finishReason: { unified: failSecond ? "error" : "stop", raw: undefined },
      usage: USAGE,
    },
  ];
  let calls = 0;
  // As a provider's request would, a call fails once its signal aborts.
  const m = mockModel({
    doStream: async ({ abortSignal }) => {
      abortSignal?.throwIfAborted();
      return {
        stream: simulateReadableStream({ chunks: calls++ ? second : first }),
      };
    },
    doGenerate: async ({ abortSignal }) => {
      abortSignal?.throwIfAborted();
      if (calls++ === 0) {
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

function lagStreamEnds() {
  const reader = new ReadableStream().getReader();
  const proto = Object.getPrototypeOf(reader) as ReadableStreamDefaultReader;
  reader.releaseLock();
  const read = proto.read;
  proto.read = async function (this: ReadableStreamDefaultReader) {
    const result = await read.call(this);
    if (result.done) await sleep(5);
    return result;
  } as typeof read;
  return () => {
    proto.read = read;
  };
}

const runArgs = {
  threadId: v.string(),
  runner: v.union(
    v.literal("generateText"),
    v.literal("streamText"),
    v.literal("returnImmediately"),
  ),
  scenario: v.optional(
    v.union(v.literal("stopWithToolCall"), v.literal("deniedApproval")),
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
  // When a retry from the same prompt starts.
  restartAt: v.optional(
    v.union(v.literal("afterFirstStep"), v.literal("beforeAnswer")),
  ),
  deletePromptInTool: v.optional(v.boolean()),
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
  throwAtFinish: v.optional(v.boolean()),
  slowFailure: v.optional(v.boolean()),
  abortOnCreate: v.optional(v.boolean()),
  // Every stream's end arrives a moment after its last part, as on a slower
  // machine.
  lagStreamEnds: v.optional(v.boolean()),
};
type RunArgs = Omit<ObjectType<typeof runArgs>, "threadId">;

const run = app.action({
  args: runArgs,
  handler: async (ctx, args) => {
    const m = args.retryFirstAttempt
      ? retriedModel()
      : model(args.scenario ? "stop" : "tool-calls", {
          failFirst: args.failFirst,
          failSecond: args.failSecond,
        });
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
    let usageCalls = 0;
    let stepEnds = 0;
    let endCalls = 0;
    let aborts = 0;
    let savedAtEnd: Row[] | undefined;
    let stopRequested = false;
    const abort = new AbortController();
    let duringSecondStep: Row[] | undefined;
    const agent = new Agent(components.agent, {
      name: "steps",
      languageModel: m.model,
      tools: {
        lookup: createTool({
          inputSchema: z.object({}),
          execute: async () => {
            if (args.deletePromptInTool) {
              await ctx.runMutation(components.agent.messages.deleteByIds, {
                messageIds: [await firstMessageId()],
              });
            }
            if (args.abortInTool) abort.abort("Stopped");
            return { ok: true };
          },
        }),
      },
      usageHandler: async () => {
        usageCalls++;
      },
    });
    const callArgs = {
      prompt: "Go.",
      ...(args.readStream ? { onError: () => {} } : {}),
      stopWhen: [
        isStepCount(5),
        () => {
          if (args.stopWhenThrows) throw new Error("stopWhen failed");
          return stopRequested || (!!args.stopOnUsage && usageCalls > 0);
        },
      ],
      maxRetries: 0,
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
        }
        return undefined;
      },
      onStepEnd: async () => {
        stepEnds++;
        if (args.restartAt === "afterFirstStep" && stepEnds === 1) {
          await restart();
        }
        stopRequested = !!args.stopFromStepEnd;
        if (args.abortInStepEnd) abort.abort("Stopped");
      },
      onEnd: async () => {
        endCalls++;
        savedAtEnd = await readThread(ctx, args.threadId);
      },
      onAbort: () => {
        aborts++;
      },
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
        const { pendingMessageId, format, createStream } = mutationArgs as {
          pendingMessageId?: string;
          format?: string;
          createStream?: object;
        };
        // Aborts once a step save has committed, before its reply arrives.
        if (args.abortDuringSave && pendingMessageId) {
          abort.abort("Stopped");
          await sleep(100);
        }
        // Someone else aborts the stream as soon as it is created, before
        // the creation's reply arrives.
        if (args.abortOnCreate && (format ?? createStream) !== undefined) {
          await ctx.runMutation(components.agent.streams.abort, {
            streamId: createStream
              ? (result as { streamId: string }).streamId
              : (result as string),
            reason: "Stopped elsewhere",
          });
          await sleep(50);
        }
        return result;
      }) as ActionCtx["runMutation"],
    };
    const threadArgs = { threadId: args.threadId };
    let error: string | null = null;
    let seen: { errorParts: string[]; text: string } | undefined;
    const restoreStreamEnds = args.lagStreamEnds ? lagStreamEnds() : undefined;
    try {
      if (args.runner === "generateText") {
        await agent.generateText(intercepted, threadArgs, callArgs);
      } else {
        const result = await agent.streamText(
          intercepted,
          threadArgs,
          callArgs,
          {
            saveStreamDeltas: {
              throttleMs: 0,
              returnImmediately: args.runner === "returnImmediately",
            },
          },
        );
        if (args.readStream) {
          seen = { errorParts: [], text: "" };
          for await (const part of result.fullStream) {
            if (part.type === "error") {
              seen.errorParts.push(errorToString(part.error));
            }
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
    restoreStreamEnds?.();
    const streams = await ctx.runQuery(components.agent.streams.list, {
      threadId: args.threadId,
      statuses: ["streaming", "finished", "aborted"],
    });
    return {
      error,
      usageCalls,
      endCalls,
      aborts,
      modelCalls: m.calls(),
      duringSecondStep: duringSecondStep ?? null,
      saved: await readThread(ctx, args.threadId),
      savedAtEnd: savedAtEnd ?? null,
      streams: streams.map((s) => s.status),
      seen: seen ?? null,
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

// generateText and streamText wire the AI SDK's hooks separately, and a
// streamed step's parts are recovered from its deltas.
describe.each(["generateText", "streamText"] as const)(
  "saving steps with %s",
  (runner) => {
    const streamed = runner === "streamText";

    test.each([
      { scenario: "stopWithToolCall", first: LOOKUP },
      { scenario: "deniedApproval", first: DENIED },
    ] as const)(
      "saves each step as the SDK runs it: $scenario (#388)",
      async ({ scenario, first }) => {
        const r = await go({ runner, scenario });
        expect(r.duringSecondStep).toEqual([USER, ...first, PENDING]);
        expect(r.saved).toEqual([USER, ...first, ANSWER]);
      },
    );

    test("a failed step save stops the generation (#419)", async () => {
      const r = await go({ runner, failSave: "first" });
      expect(r.modelCalls).toBe(1);
      expect(r.error).toBe("first save failed");
      expect(r.saved).toEqual(
        streamed
          ? [USER, ...LOOKUP.map((row) => failed(row, "first save failed"))]
          : [USER, failed(EMPTY, "first save failed")],
      );
      expect(r.streams).toEqual(streamed ? ["aborted"] : []);
    });

    test("a failed final save fails the generation (#419)", async () => {
      const r = await go({ runner, failSave: "final" });
      expect(r.error).toBe("final save failed");
      expect(r.saved).toEqual([
        USER,
        ...LOOKUP,
        failed(streamed ? ANSWER : EMPTY, "final save failed"),
      ]);
      expect(r.streams).toEqual(streamed ? ["aborted"] : []);
    });
  },
);

describe("generateText", () => {
  // Its reply, with the id of the pending message it made, never arrived.
  test("a step save that commits and then fails stops, and settles only the messages it knows", async () => {
    const r = await go({
      runner: "generateText",
      failSave: "first",
      failSaveAfterCommit: true,
    });
    expect(r.modelCalls).toBe(1);
    expect(r.error).toBe("first save failed");
    expect(r.saved).toEqual([USER, ...LOOKUP, PENDING]);
  });

  test("a final save that commits and then fails rejects", async () => {
    const r = await go({
      runner: "generateText",
      failSave: "final",
      failSaveAfterCommit: true,
    });
    expect(r.error).toBe("final save failed");
    expect(r.saved).toEqual([USER, ...LOOKUP, ANSWER]);
  });

  test("an abort while a step's tool runs keeps the step and rejects", async () => {
    const r = await go({ runner: "generateText", abortInTool: true });
    expect(r.saved).toEqual([USER, ...LOOKUP, failed(EMPTY, "Stopped")]);
    expect(r.error).toBe("Stopped");
  });

  test("stopWhen sees what onStepEnd set", async () => {
    const r = await go({ runner: "generateText", stopFromStepEnd: true });
    expect(r.saved).toEqual([USER, ...LOOKUP]);
  });

  test("stopWhen sees the usage of the step it follows", async () => {
    const r = await go({ runner: "generateText", stopOnUsage: true });
    expect(r.saved).toEqual([USER, ...LOOKUP]);
  });

  test("a failure between steps keeps the step the SDK finished", async () => {
    const r = await go({ runner: "generateText", stopWhenThrows: true });
    expect(r.saved).toEqual([
      USER,
      ...LOOKUP,
      failed(EMPTY, "stopWhen failed"),
    ]);
    expect(r.error).toBe("stopWhen failed");
  });

  test.each([
    { failSave: undefined, saved: [USER, ...LOOKUP], error: null },
    {
      failSave: "first",
      saved: [USER, failed(EMPTY, "first save failed")],
      error: "first save failed",
    },
  ] as const)(
    "an abort in onStepEnd saves the step first, or reports its failed save: $failSave",
    async ({ failSave, saved, error }) => {
      const r = await go({
        runner: "generateText",
        stopFromStepEnd: true,
        abortInStepEnd: true,
        failSave,
      });
      expect(r.saved).toEqual(saved);
      expect(r.error).toBe(error);
    },
  );

  test("a retry between steps stops the attempt it replaced", async () => {
    const r = await go({ runner: "generateText", restartAt: "afterFirstStep" });
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
    const r = await go({ runner: "generateText", deletePromptInTool: true });
    expect(r.modelCalls).toBe(1);
    expect(r.error).toBe("The prompt message was deleted");
  });
});

describe("streamText", () => {
  test("onEnd sees the answer saved", async () => {
    const r = await go({ runner: "streamText" });
    expect(r.savedAtEnd).toEqual([USER, ...LOOKUP, ANSWER]);
  });

  test("a delta write that fails after a tool ran keeps its step, and the result rejects", async () => {
    const r = await go({
      runner: "streamText",
      failToolResultDelta: true,
      readStream: true,
    });
    expect(r.saved).toEqual([USER, ...LOOKUP, failed(EMPTY, "delta failed")]);
    expect(r.seen?.text).toMatch(/^rejected: /);
    expect(r.streams).toEqual(["aborted"]);
  });

  test("a step a provider error ends still reports its usage", async () => {
    const r = await go({ runner: "streamText", failSecond: true });
    expect(r.usageCalls).toBe(2);
    expect(r.saved).toEqual([
      USER,
      ...LOOKUP,
      failed(ANSWER, "provider failed"),
    ]);
  });

  test("a provider error in a step the SDK would continue past stops it there", async () => {
    const r = await go({ runner: "streamText", failFirst: true });
    expect(r.saved).toEqual([
      USER,
      ...LOOKUP.map((row) => failed(row, "provider failed")),
    ]);
    expect(r.modelCalls).toBe(1);
    expect(r.streams).toEqual(["aborted"]);
  });

  // Ending the generation fails its stream, which isn't the caller's abort.
  test.each([
    { failSecond: true, endCalls: 1 },
    { failSave: "final", endCalls: 0 },
  ] as const)(
    "a failed generation doesn't call onAbort: %o",
    async ({ endCalls, ...failure }) => {
      const r = await go({
        runner: "streamText",
        ...failure,
        lagStreamEnds: true,
      });
      expect({ endCalls: r.endCalls, aborts: r.aborts }).toEqual({
        endCalls,
        aborts: 0,
      });
    },
  );

  // The stream is still open, so the AI SDK reports the abort there.
  test("an abort in onStepEnd fails the reply with the abort, and its failed save still rejects", async () => {
    const r = await go({
      runner: "streamText",
      stopFromStepEnd: true,
      abortInStepEnd: true,
      failSave: "first",
    });
    expect(r.saved).toEqual([USER, failed(EMPTY, "Stopped")]);
    expect(r.error).toBe("first save failed");
  });

  test("a step save that commits and then fails leaves nothing pending", async () => {
    const r = await go({
      runner: "streamText",
      failSave: "first",
      failSaveAfterCommit: true,
    });
    expect(r.modelCalls).toBe(1);
    expect(r.error).toBe("first save failed");
    expect(r.saved).toEqual([
      USER,
      ...LOOKUP,
      failed(EMPTY, "first save failed"),
    ]);
    expect(r.streams).toEqual(["aborted"]);
  });

  test("an abort during a step save fails the next step", async () => {
    const r = await go({ runner: "streamText", abortDuringSave: true });
    expect(r.saved).toEqual([USER, ...LOOKUP, failed(EMPTY, "Stopped")]);
  });

  test("a stream aborted while it is being created ends aborted, with nothing pending", async () => {
    const r = await go({ runner: "streamText", abortOnCreate: true });
    expect(r.saved).not.toContainEqual(PENDING);
    expect(r.streams).toEqual(["aborted"]);
  });

  test("a stream retry after a provider error saves the answer (#428)", async () => {
    const r = await go({ runner: "streamText", retryFirstAttempt: true });
    expect(r.saved).toEqual([USER, ANSWER]);
    expect(r.streams).toEqual(["finished"]);
  });

  test("a transform that throws at the end keeps the answer", async () => {
    const r = await go({ runner: "streamText", throwAtFinish: true });
    expect(r.saved).toEqual([
      USER,
      ...LOOKUP,
      ANSWER,
      failed(EMPTY, "transform failed"),
    ]);
    expect(r.error).toBe("transform failed");
  });

  test("an abort before onStepEnd saves the step once", async () => {
    const r = await go({ runner: "streamText", abortBeforeStepEnd: true });
    expect(
      r.saved.filter((row) => row.parts.includes("tool-result")),
    ).toHaveLength(1);
  });

  test("a retry between steps keeps the step it replaced once", async () => {
    const r = await go({ runner: "streamText", restartAt: "afterFirstStep" });
    expect(r.error).toBe("Restarting");
    expect(r.saved).toEqual([
      USER,
      ...LOOKUP.map((row) => failed(row, "Restarting")),
      PENDING,
    ]);
  });

  test("a retry during the answer stops the attempt it replaced at its first delta", async () => {
    const r = await go({ runner: "streamText", restartAt: "beforeAnswer" });
    expect(r.error).toBe("Restarting");
    expect(r.saved).toEqual([
      USER,
      ...LOOKUP,
      failed(EMPTY, "Restarting"),
      PENDING,
    ]);
    expect(r.streams).toEqual(["aborted"]);
  });
});

// The caller reads the result instead of awaiting the generation.
describe("returnImmediately", () => {
  test("a failed step save reaches the stream once, as an error part (#419)", async () => {
    const r = await go({
      runner: "returnImmediately",
      failSave: "first",
      readStream: true,
    });
    // As after any error the SDK streams, the text is the finished steps'.
    expect(r.seen).toEqual({
      errorParts: ["first save failed"],
      text: "resolved: ",
    });
  });

  test("the result rejects when the answer fails to save", async () => {
    const r = await go({
      runner: "returnImmediately",
      failSave: "final",
      awaitTextOnly: true,
    });
    expect(r.error).toBe("final save failed");
  });

  test("a transform that stops the stream fails the step it cut off before the result resolves", async () => {
    const r = await go({
      runner: "returnImmediately",
      stopAtAnswer: true,
      awaitTextOnly: true,
      slowFailure: true,
    });
    // A streamed step's parts are recovered into its message.
    expect(r.saved).toEqual([
      USER,
      ...LOOKUP,
      failed(ANSWER, "The generation stopped before its step ended"),
    ]);
    expect(r.streams).toEqual(["aborted"]);
    // The caller stopped it, so nothing rejects.
    expect(r.error).toBe(null);
  });
});
