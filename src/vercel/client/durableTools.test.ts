import { beforeEach, expect, test } from "vitest";
import { v } from "convex/values";
import { defineSchema, makeFunctionReference } from "convex/server";
import { defineTestApp } from "convex-test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { stepCountIs, type StepResult, type ToolSet } from "ai";
import { z } from "zod/v4";
import { Agent, createThread, createTool } from "../index.js";
import type { MessageDoc } from "../../validators.js";
import componentTest from "../../test.js";
import { mockModel, type MockLanguageModel } from "./mockModel.js";
import type { ActionCtx } from "./types.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const forever = new Promise<void>(() => {});
const toolStep = (
  calls: { id: string; tool: string; input?: object }[],
  before: LanguageModelV4StreamPart[] = [],
): LanguageModelV4StreamPart[] => [
  { type: "stream-start", warnings: [] },
  ...before,
  ...calls.map(
    (call): LanguageModelV4StreamPart => ({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.tool,
      input: JSON.stringify(call.input ?? {}),
    }),
  ),
  { type: "finish", finishReason: { unified: "tool-calls", raw: "" }, usage },
];

// Each call streams its next step.
function scripted(...steps: (LanguageModelV4StreamPart[] | string)[]) {
  let call = 0;
  return mockModel({
    doStream: async () => {
      const step = steps[call++];
      const parts: LanguageModelV4StreamPart[] = Array.isArray(step)
        ? step
        : [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: step },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage,
            },
          ];
      return {
        stream: new ReadableStream({
          start(controller) {
            parts.forEach((part) => controller.enqueue(part));
            controller.close();
          },
        }),
      };
    },
  }) as MockLanguageModel;
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

const app = defineTestApp({
  schema: defineSchema({}),
  components: { agent: componentTest },
});
const components = app.components;

type Ids = { threadId: string; promptMessageId: string };
const generate = makeFunctionReference<"action", Ids>("durable:generate");
const attempts: ((ctx: ActionCtx, ids: Ids) => Promise<void>)[] = [];
const { createTest } = app.defineModules({
  durable: {
    generate: app.action({
      args: { threadId: v.string(), promptMessageId: v.string() },
      handler: async (ctx, ids) => {
        await attempts.shift()!(ctx as ActionCtx, ids);
      },
    }),
  },
});
beforeEach(() => {
  attempts.length = 0;
});
const agent = new Agent(components.agent, {
  name: "durable",
  languageModel: mockModel(),
  stopWhen: stepCountIs(3),
});
const deltas = {
  saveStreamDeltas: { throttleMs: 0, chunking: (b: string) => b || null },
};
const run = (
  ctx: ActionCtx,
  model: MockLanguageModel,
  ids: Ids,
  more: object = {},
) =>
  agent
    .streamText(
      ctx,
      { threadId: ids.threadId },
      { ...ids, model, ...more },
      deltas,
    )
    .then((result) => result.consumeStream());

// A job that dies once `dies` is true of a mutation it runs, before that
// mutation runs.
const dying =
  (
    model: MockLanguageModel,
    dies: (args: object) => boolean,
    more: object = {},
  ) =>
  async (ctx: ActionCtx, ids: Ids) => {
    const died = gate();
    const runMutation = ((ref: never, args: object) => {
      if (dies(args ?? {})) {
        died.open();
        return forever;
      }
      return ctx.runMutation(ref, args as never);
    }) as ActionCtx["runMutation"];
    run({ ...ctx, runMutation }, model, ids, more).catch(() => {});
    await died.opened;
    throw new Error("crashed");
  };

async function submitted() {
  const t = createTest();
  const threadId = await t.mutation((ctx) =>
    createThread(ctx, components.agent, {}),
  );
  const { messageId, jobId } = await t.mutation((ctx) =>
    agent.saveMessage(ctx, { threadId, prompt: "Go.", generate }),
  );
  const ids = { threadId, promptMessageId: messageId };
  const docs = async () =>
    (
      await t.query((ctx) =>
        ctx.runQuery(components.agent.messages.listMessagesByThreadId, {
          threadId,
          order: "asc",
        }),
      )
    ).page as MessageDoc[];
  const answered = async () => {
    const last = (await docs()).at(-1);
    return last?.message?.role === "assistant" && last.status === "success";
  };
  return {
    t,
    ids,
    docs,
    retried: async () => {
      await t.finishAllScheduledFunctions(() => {});
      await until(async () => {
        const job = await t.mutation((ctx) => agent.retryGeneration(ctx, ids));
        return job !== null && job !== jobId;
      });
      await t.finishAllScheduledFunctions(() => {});
      await until(answered);
    },
    answered,
  };
}

test("a job whose context handler reads the user before its first save runs its tools for the user who saved its prompt", async () => {
  const t = createTest();
  const threadId = await t.mutation((ctx) =>
    createThread(ctx, components.agent, { userId: "owner" }),
  );
  let actingFor: string | undefined;
  const whoami = createTool({
    inputSchema: z.object({}),
    execute: async (ctx) => (actingFor = ctx.userId),
  });
  attempts.push((ctx, ids) =>
    agent
      .streamText(
        ctx,
        { threadId: ids.threadId },
        {
          ...ids,
          model: scripted(toolStep([{ id: "w", tool: "whoami" }]), "Done."),
          tools: { whoami },
          stopWhen: stepCountIs(2),
        },
        {
          ...deltas,
          contextHandler: async (_ctx, { recent, inputPrompt }) => [
            ...recent,
            ...inputPrompt,
          ],
        },
      )
      .then((result) => result.consumeStream()),
  );
  await t.mutation((ctx) =>
    agent.saveMessage(ctx, {
      threadId,
      userId: "guest",
      prompt: "Go.",
      generate,
    }),
  );
  await t.finishAllScheduledFunctions(() => {});
  expect(actingFor).toBe("guest");
});

const broken = createTool({
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    throw new Error("broke");
  },
});

// A job that saves a step whose tool failed, then dies streaming the next.
const crashesAfterBrokenStep = dying(
  scripted(toolStep([{ id: "b1", tool: "broken" }]), "Half."),
  (args) => JSON.stringify(args).includes("Half."),
  { tools: { broken } },
);

test("a resumed job's stop conditions see its saved steps' usage and tool errors, first on the saved steps alone", async () => {
  attempts.push(crashesAfterBrokenStep);
  const seen: unknown[] = [];
  attempts.push((ctx, ids) =>
    run(ctx, scripted(toolStep([{ id: "c2", tool: "broken" }]), "Done."), ids, {
      tools: { broken },
      stopWhen: ({ steps }: { steps: StepResult<ToolSet>[] }) => {
        seen.push(
          steps.map((step) => [
            step.usage.totalTokens,
            step.content.map((part) => part.type),
          ]),
        );
        return steps.length >= 3;
      },
    }),
  );
  const { retried } = await submitted();
  await retried();
  expect(seen).toEqual([
    [[2, ["tool-call", "tool-error"]]],
    [
      [2, ["tool-call", "tool-error"]],
      [2, ["tool-call", "tool-error"]],
    ],
  ]);
});

test("a job stopped mid-stream ends its reply once, by its stream's close, as stopped with what it streamed, and its generation ends without error", async () => {
  const more = gate();
  const model = mockModel({
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "Hello" });
          await more.opened;
          controller.enqueue({ type: "text-delta", id: "t", delta: " world" });
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage,
          });
          controller.close();
        },
      }),
    }),
  }) as MockLanguageModel;
  const calls: { fn: string; threw?: unknown; result?: unknown }[] = [];
  let ended: { error?: unknown } | undefined;
  attempts.push(async (ctx, ids) => {
    const runMutation = (async (ref: never, args: object) => {
      const fn = String(
        (ref as Record<symbol, unknown>)[Symbol.for("toReferencePath")] ?? ref,
      );
      try {
        const result = await ctx.runMutation(ref, args as never);
        calls.push({ fn, result });
        return result;
      } catch (threw) {
        calls.push({ fn, threw });
        throw threw;
      }
    }) as ActionCtx["runMutation"];
    await run({ ...ctx, runMutation }, model, ids).then(
      () => (ended = {}),
      (error: unknown) => (ended = { error }),
    );
  });
  const { t, ids, docs } = await submitted();
  const job = t.finishAllScheduledFunctions(() => {});
  await until(async () =>
    calls.some((c) => c.fn.endsWith("addDelta") && c.result === true),
  );
  expect(
    await t.mutation((ctx) =>
      agent.abortGeneration(ctx, { ...ids, reason: "Stopped" }),
    ),
  ).toBe(true);
  more.open();
  await job;
  await until(async () => ended !== undefined);
  const reply = (await docs()).at(-1)!;
  expect([reply.status, reply.text, reply.error]).toEqual([
    "failed",
    "Hello",
    "Stopped",
  ]);
  // After its refused delta, the job's only write is its stream's close.
  const refused = calls.findIndex(
    (c) => c.fn.endsWith("streams/addDelta") && c.result === false,
  );
  expect(refused).toBeGreaterThan(0);
  expect(
    calls.slice(refused + 1).map((c) => [c.fn.split("/").at(-1), c.threw]),
  ).toEqual([["fail", undefined]]);
  expect(ended).toEqual({});
});

test("a reply stopped while its job still streams stays out of the next generation's context, and the thread shows it failed with what it streamed", async () => {
  const more = gate();
  const model = mockModel({
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "Kept." });
          await more.opened;
          controller.close();
        },
      }),
    }),
  }) as MockLanguageModel;
  let streamed = false;
  attempts.push(async (ctx, ids) => {
    const runMutation = (async (ref: never, args: object) => {
      const result = await ctx.runMutation(ref, args as never);
      if (
        String(
          (ref as Record<symbol, unknown>)[Symbol.for("toReferencePath")],
        ).endsWith("addDelta")
      ) {
        streamed = true;
      }
      return result;
    }) as ActionCtx["runMutation"];
    await run({ ...ctx, runMutation }, model, ids).catch(() => {});
  });
  const { t, ids, docs } = await submitted();
  const job = t.finishAllScheduledFunctions(() => {});
  await until(async () => streamed);
  let context = "";
  const next = new Agent(components.agent, {
    name: "next",
    languageModel: mockModel(),
    contextHandler: async (_ctx, { allMessages }) => {
      context = JSON.stringify(allMessages);
      return allMessages;
    },
  });
  try {
    await t.mutation((ctx) => agent.abortGeneration(ctx, ids));
    await t.action(async (ctx) => {
      const { messageId } = await next.saveMessage(ctx, {
        threadId: ids.threadId,
        prompt: "Next.",
      });
      await next.generateText(
        ctx,
        { threadId: ids.threadId },
        { promptMessageId: messageId },
      );
    });
  } finally {
    more.open();
    await job;
  }
  expect(context).toContain("Next.");
  expect(context).not.toContain("Kept.");
  const stopped = (await docs()).find((m) => m.text === "Kept.");
  expect([stopped?.status, stopped?.error]).toEqual(["failed", "Stopped"]);
});
