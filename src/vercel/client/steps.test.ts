import { describe, expect, test } from "vitest";
import { v } from "convex/values";
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
function model(firstFinish: "tool-calls" | "stop", failSecond: boolean) {
  const first: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
    CALL,
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
  const m = mockModel({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: calls++ ? second : first }),
    }),
    doGenerate: async () => {
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

type Row = { role?: string; parts: string[]; status: string };

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
    }),
  );
}

// Throws on the first or second step save: the addMessages that stores an
// assistant tool call, or the assistant answer.
function failingSave(ctx: ActionCtx, which: "first" | "final" | undefined) {
  if (!which) return ctx;
  const part = which === "first" ? "tool-call" : "text";
  return {
    ...ctx,
    runMutation: (async (reference, args) => {
      const messages = (args as { messages?: MessageDoc[] }).messages;
      if (
        messages?.some(
          (m) =>
            m.message?.role === "assistant" &&
            Array.isArray(m.message.content) &&
            m.message.content.some((p) => p.type === part),
        )
      ) {
        throw new Error(`${which} save failed`);
      }
      return ctx.runMutation(reference, args);
    }) as ActionCtx["runMutation"],
  };
}

// Each save takes longer than the harness waits after the generation returns.
function slowSaves(ctx: ActionCtx, onlyTheAnswer = false): ActionCtx {
  return {
    ...ctx,
    runMutation: (async (reference, args) => {
      const messages = (args as { messages?: MessageDoc[] }).messages;
      if (
        !onlyTheAnswer ||
        messages?.some(
          (m) =>
            m.message?.role === "assistant" &&
            (typeof m.message.content === "string" ||
              m.message.content.some((p) => p.type === "text")),
        )
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return ctx.runMutation(reference, args);
    }) as ActionCtx["runMutation"],
  };
}

// Aborts once a step save has committed, before its reply arrives.
function abortsOnReply(ctx: ActionCtx, abort: () => void): ActionCtx {
  return {
    ...ctx,
    runMutation: (async (reference, args) => {
      const result = await ctx.runMutation(reference, args);
      if ((args as { pendingMessageId?: string }).pendingMessageId) {
        abort();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return result;
    }) as ActionCtx["runMutation"],
  };
}

const runner = v.union(
  v.literal("generateText"),
  v.literal("streamText"),
  v.literal("returnImmediately"),
  v.literal("noDeltas"),
);
const scenario = v.union(
  v.literal("toolCalls"),
  v.literal("stopWithToolCall"),
  v.literal("deniedApproval"),
);

const run = app.action({
  args: {
    threadId: v.string(),
    runner,
    scenario,
    failSave: v.optional(v.union(v.literal("first"), v.literal("final"))),
    failSecond: v.optional(v.boolean()),
    restartDuringFirstStep: v.optional(v.boolean()),
    restartAfterFirstStep: v.optional(v.boolean()),
    stopFromStepEnd: v.optional(v.boolean()),
    stopWhenThrows: v.optional(v.boolean()),
    abortInStepEnd: v.optional(v.boolean()),
    abortDuringSave: v.optional(v.boolean()),
    awaitTextOnly: v.optional(v.boolean()),
    retryFirstAttempt: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const m = args.retryFirstAttempt
      ? retriedModel()
      : model(
          args.scenario === "toolCalls" ? "tool-calls" : "stop",
          args.failSecond ?? false,
        );
    // What a retry from the same prompt does.
    const restart = async () => {
      const { page } = await ctx.runQuery(
        components.agent.messages.listMessagesByThreadId,
        {
          threadId: args.threadId,
          order: "asc",
          paginationOpts: { cursor: null, numItems: 1 },
        },
      );
      await ctx.runMutation(components.agent.messages.addMessages, {
        threadId: args.threadId,
        promptMessageId: (page[0] as MessageDoc)._id,
        failPendingSteps: true,
        messages: [
          { message: { role: "assistant", content: [] }, status: "pending" },
        ],
      });
    };
    let usageCalls = 0;
    let stepEnds = 0;
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
            if (args.restartDuringFirstStep) await restart();
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
      stopWhen: [
        isStepCount(5),
        () => {
          if (args.stopWhenThrows) throw new Error("stopWhen failed");
          return stopRequested;
        },
      ],
      maxRetries: 0,
      ...(args.retryFirstAttempt ? { streamRetries: 1 } : {}),
      abortSignal: abort.signal,
      ...(args.scenario === "deniedApproval"
        ? { toolApproval: () => ({ type: "denied" as const, reason: "No." }) }
        : {}),
      prepareStep: async ({ stepNumber }: { stepNumber: number }) => {
        if (stepNumber === 1) {
          duringSecondStep = await readThread(ctx, args.threadId);
        }
        return undefined;
      },
      onStepEnd: async () => {
        stepEnds++;
        if (args.restartAfterFirstStep && stepEnds === 1) await restart();
        stopRequested = !!args.stopFromStepEnd;
        if (args.abortInStepEnd) abort.abort("Stopped");
      },
    };
    const saving = failingSave(
      args.abortInStepEnd || args.awaitTextOnly
        ? slowSaves(ctx, args.awaitTextOnly)
        : args.abortDuringSave
          ? abortsOnReply(ctx, () => abort.abort("Stopped"))
          : ctx,
      args.failSave,
    );
    const threadArgs = { threadId: args.threadId };
    let error: string | null = null;
    try {
      if (args.runner === "generateText") {
        await agent.generateText(saving, threadArgs, callArgs);
      } else {
        const result = await agent.streamText(
          saving,
          threadArgs,
          callArgs,
          args.runner === "noDeltas"
            ? {}
            : {
                saveStreamDeltas: {
                  throttleMs: 0,
                  returnImmediately: args.runner === "returnImmediately",
                },
              },
        );
        if (args.awaitTextOnly) {
          await result.text;
          return { saved: await readThread(ctx, args.threadId) };
        }
        await result.consumeStream();
      }
    } catch (e) {
      error = errorToString(e);
    }
    if (args.awaitTextOnly) {
      return { saved: await readThread(ctx, args.threadId) };
    }
    // Let a returnImmediately generation's own cleanup land.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const streams = await ctx.runQuery(components.agent.streams.list, {
      threadId: args.threadId,
      statuses: ["streaming", "finished", "aborted"],
    });
    return {
      error,
      usageCalls,
      stepEnds,
      modelCalls: m.calls(),
      duringSecondStep: duringSecondStep ?? null,
      saved: await readThread(ctx, args.threadId),
      streams: streams.map((s) => s.status),
    };
  },
});

const { api, createTest } = app.defineModules({ steps: { run } });

async function go(args: {
  runner: "generateText" | "streamText" | "returnImmediately" | "noDeltas";
  scenario: "toolCalls" | "stopWithToolCall" | "deniedApproval";
  failSave?: "first" | "final";
  failSecond?: boolean;
  restartDuringFirstStep?: boolean;
  restartAfterFirstStep?: boolean;
  stopFromStepEnd?: boolean;
  stopWhenThrows?: boolean;
  abortInStepEnd?: boolean;
  abortDuringSave?: boolean;
  awaitTextOnly?: boolean;
  retryFirstAttempt?: boolean;
}) {
  const t = createTest();
  const threadId = await t.run((ctx) =>
    createThread(ctx, components.agent, {}),
  );
  return t.action(api.steps.run, { threadId, ...args });
}

const USER: Row = { role: "user", parts: ["text"], status: "success" };
const PENDING: Row = { role: "assistant", parts: [], status: "pending" };
const FAILED: Row = { role: "assistant", parts: [], status: "failed" };
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
  ] as const)(
    "saves every step the SDK runs: $scenario (#388)",
    async ({ scenario, first }) => {
      expect(await go({ runner, scenario })).toEqual({
        error: null,
        usageCalls: 2,
        stepEnds: 2,
        modelCalls: 2,
        duringSecondStep: [USER, ...first, PENDING],
        saved: [USER, ...first, ANSWER],
        streams: streamed ? ["finished"] : [],
      });
    },
  );

  test("a failed step save stops the generation", async () => {
    const r = await go({ runner, scenario: "toolCalls", failSave: "first" });
    expect(r.modelCalls).toBe(1);
    // The SDK calls onStepEnd before the step is saved, as on main.
    expect(r.stepEnds).toBe(1);
    // A streamed step's parts are recovered into the failed message.
    expect(r.saved).toEqual(
      streamed
        ? [USER, ...LOOKUP.map((row) => ({ ...row, status: "failed" }))]
        : [USER, FAILED],
    );
    if (awaited) expect(r.error).toBe("first save failed");
  });

  test("a failed final save fails the generation", async () => {
    const r = await go({ runner, scenario: "toolCalls", failSave: "final" });
    expect(r.saved).toEqual([
      USER,
      ...LOOKUP,
      streamed ? { ...FAILED, parts: ["text"] } : FAILED,
    ]);
    if (awaited) expect(r.error).toBe("final save failed");
  });

  test("a provider error in the second step keeps the first", async () => {
    const r = await go({ runner, scenario: "toolCalls", failSecond: true });
    // streamText keeps the partial text, and its usage, from the errored step.
    expect(r.saved).toEqual([
      USER,
      ...LOOKUP,
      runner === "generateText" ? FAILED : { ...FAILED, parts: ["text"] },
    ]);
    expect(r.usageCalls).toBe(runner === "generateText" ? 1 : 2);
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

  test("a failure between steps keeps the step the SDK finished", async () => {
    const r = await go({ runner, scenario: "toolCalls", stopWhenThrows: true });
    expect(r.modelCalls).toBe(1);
    expect(r.saved).toEqual([USER, ...LOOKUP]);
    if (awaited) expect(r.error).toBe("stopWhen failed");
  });

  test("an abort in onStepEnd keeps the step before the generation ends", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      stopFromStepEnd: true,
      abortInStepEnd: true,
    });
    expect(r.saved).toEqual([USER, ...LOOKUP]);
  });

  test("an abort during a step save stops the next step", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      abortDuringSave: true,
    });
    expect(r.modelCalls).toBe(1);
    expect(r.saved).toEqual([USER, ...LOOKUP]);
  });

  test("the answer is saved before the result resolves", async () => {
    const r = await go({ runner, scenario: "toolCalls", awaitTextOnly: true });
    expect(r.saved).toEqual([USER, ...LOOKUP, ANSWER]);
  });

  test.skipIf(runner === "generateText")(
    "a stream retry after a provider error saves the answer (#428)",
    async () => {
      expect(
        await go({ runner, scenario: "toolCalls", retryFirstAttempt: true }),
      ).toEqual({
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

  test("a retry from the same prompt stops the attempt it replaced", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      restartDuringFirstStep: true,
    });
    expect(r.modelCalls).toBe(1);
  });

  test("a retry between steps stops the attempt it replaced", async () => {
    const r = await go({
      runner,
      scenario: "toolCalls",
      restartAfterFirstStep: true,
    });
    expect(r.modelCalls).toBe(1);
    // The retry's own pending message, which this harness never fills.
    expect(r.saved).toEqual([USER, ...LOOKUP, PENDING]);
  });
});
