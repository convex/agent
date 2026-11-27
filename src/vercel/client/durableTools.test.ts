import { beforeEach, expect, test } from "vitest";
import { v } from "convex/values";
import {
  defineSchema,
  defineTable,
  makeFunctionReference,
  type FunctionReference,
} from "convex/server";
import { defineTestApp } from "convex-test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  stepCountIs,
  streamText,
  tool,
  type StepResult,
  type ToolSet,
} from "ai";
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
  schema: defineSchema({
    orders: defineTable({ item: v.string(), key: v.string() }),
  }),
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
    place: app.internalMutation({
      args: { item: v.string(), key: v.string() },
      handler: async (ctx, order) => {
        await ctx.db.insert("orders", order);
        return `placed ${order.item}`;
      },
    }),
  },
});
const place = makeFunctionReference<"mutation">(
  "durable:place",
) as unknown as FunctionReference<
  "mutation",
  "internal",
  { item: string; key: string },
  string
>;

// What each tool body saw: `${ctx.messageId}:${toolCallId}`, tagged.
let keys: string[] = [];
// Calls whose tool body never returns, the first time each runs.
let holds = new Set<string>();
let placing = gate();
let placeGo: Promise<void> = Promise.resolve();
let charging = gate();
let checking = gate();
beforeEach(() => {
  attempts.length = 0;
  keys = [];
  holds = new Set();
  placing = gate();
  placeGo = Promise.resolve();
  charging = gate();
  checking = gate();
});
const keyOf = (ctx: { messageId?: string }, toolCallId: string) =>
  `${ctx.messageId}:${toolCallId}`;
const agent = new Agent(components.agent, {
  name: "durable",
  languageModel: mockModel(),
  tools: {
    place: createTool({
      inputSchema: z.object({ item: z.string() }),
      mutation: async (ctx, { item }, { toolCallId }): Promise<string> => {
        const key = keyOf(ctx, toolCallId);
        keys.push(key);
        placing.open();
        if (holds.delete(toolCallId)) await forever;
        await placeGo;
        return ctx.runMutation(place, { item, key });
      },
    }),
    approvedPlace: createTool({
      inputSchema: z.object({ item: z.string() }),
      needsApproval: true,
      mutation: (ctx, { item }, { toolCallId }): Promise<string> =>
        ctx.runMutation(place, { item, key: keyOf(ctx, toolCallId) }),
    }),
    // Like a payment API that dedupes on an idempotency key.
    charge: createTool({
      inputSchema: z.object({}),
      execute: async (ctx, _input, { toolCallId }) => {
        keys.push(`charged ${keyOf(ctx, toolCallId)}`);
        charging.open();
        if (holds.delete(toolCallId)) await forever;
        return "charged";
      },
      resume: async (ctx, _input, { toolCallId }) => {
        keys.push(`resumed ${keyOf(ctx, toolCallId)}`);
        return "charged";
      },
    }),
    stock: createTool({
      inputSchema: z.object({}),
      query: async (_ctx, _input, { toolCallId }): Promise<string> => {
        keys.push(`checked ${toolCallId}`);
        checking.open();
        if (holds.delete(toolCallId)) await forever;
        return "in stock";
      },
    }),
    lookup: createTool({
      inputSchema: z.object({}),
      execute: async (ctx, _input, { toolCallId }) => {
        keys.push(`looked up ${keyOf(ctx, toolCallId)}`);
        return "found";
      },
    }),
    count: tool({
      inputSchema: z.object({}),
      async *execute() {
        yield "counting";
        await placeGo;
        yield "counted";
      },
    }),
  },
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
const savesRole = (role: string) => (args: object) =>
  JSON.stringify((args as { messages?: unknown }).messages ?? []).includes(
    `"role":"${role}"`,
  );

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
    orders: () => t.run((ctx) => ctx.db.query("orders").collect()),
    // The row a call was saved in.
    callRow: async (toolCallId: string) =>
      (await docs()).find(
        (m) =>
          Array.isArray(m.message?.content) &&
          m.message.content.some(
            (p) => p.type === "tool-call" && p.toolCallId === toolCallId,
          ),
      )!._id,
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

const promptOf = (model: MockLanguageModel, call: number) =>
  JSON.stringify(model.doStreamCalls[call].prompt);

test("a step of mutation calls that crashes before one commits records nothing, so the model is asked for it again", async () => {
  holds.add("p1");
  const first = scripted(
    toolStep([{ id: "p1", tool: "place", input: { item: "book" } }]),
  );
  attempts.push(async (ctx, ids) => {
    run(ctx, first, ids).catch(() => {});
    await placing.opened;
    throw new Error("crashed");
  });
  const again = scripted(
    toolStep([{ id: "p2", tool: "place", input: { item: "pen" } }]),
    "Done.",
  );
  attempts.push((ctx, ids) => run(ctx, again, ids));
  const { orders, retried } = await submitted();
  await retried();
  expect(again.doStreamCalls).toHaveLength(2);
  expect((await orders()).map((o) => o.item)).toEqual(["pen"]);
});

test("a step of mutation calls is recorded by its first mutation, so a crash after it commits replays the step: that call returns its result, and the rest run once", async () => {
  holds.add("p2");
  const writes: object[] = [];
  const first = scripted(
    toolStep([
      { id: "p1", tool: "place", input: { item: "book" } },
      { id: "p2", tool: "place", input: { item: "pen" } },
    ]),
  );
  attempts.push(async (ctx, ids) => {
    const committed = gate();
    const runMutation = (async (ref: never, args: object) => {
      writes.push(args);
      const result = await ctx.runMutation(ref, args as never);
      if ((args as { args?: { item?: string } }).args?.item === "book") {
        committed.open();
      }
      return result;
    }) as ActionCtx["runMutation"];
    run({ ...ctx, runMutation }, first, ids).catch(() => {});
    await committed.opened;
    throw new Error("crashed");
  });
  const done = scripted("Done.");
  attempts.push((ctx, ids) => run(ctx, done, ids));
  const { orders, callRow, retried } = await submitted();
  await retried();
  const row = await callRow("p1");
  expect(writes.filter((args) => "results" in args)).toEqual([]);
  expect(done.doStreamCalls).toHaveLength(1);
  expect((await orders()).map((o) => [o.item, o.key])).toEqual([
    ["book", `${row}:p1`],
    ["pen", `${row}:p2`],
  ]);
  expect(keys.filter((key) => key === `${row}:p2`)).toHaveLength(2);
});

test("a step of query calls records nothing, so a retry asks the model for it again", async () => {
  holds.add("s1");
  const first = scripted(toolStep([{ id: "s1", tool: "stock" }]));
  attempts.push(async (ctx, ids) => {
    run(ctx, first, ids).catch(() => {});
    await checking.opened;
    throw new Error("crashed");
  });
  const again = scripted(toolStep([{ id: "s2", tool: "stock" }]), "Done.");
  attempts.push((ctx, ids) => run(ctx, again, ids));
  const { retried } = await submitted();
  await retried();
  expect(again.doStreamCalls).toHaveLength(2);
  expect(keys).toEqual(["checked s1", "checked s2"]);
});

test("a replayed step sends its signed reasoning on with the step after it", async () => {
  holds.add("c1");
  const signed: LanguageModelV4StreamPart[] = [
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "Thinking." },
    {
      type: "reasoning-end",
      id: "r",
      providerMetadata: { anthropic: { signature: "sig-1" } },
    },
  ];
  const first = scripted(toolStep([{ id: "c1", tool: "charge" }], signed));
  attempts.push(async (ctx, ids) => {
    run(ctx, first, ids).catch(() => {});
    await charging.opened;
    throw new Error("crashed");
  });
  const done = scripted("Done.");
  attempts.push((ctx, ids) => run(ctx, done, ids));
  const { retried } = await submitted();
  await retried();
  const reasoning = done.doStreamCalls[0].prompt
    .flatMap((m): object[] => (Array.isArray(m.content) ? m.content : []))
    .filter((part) => "type" in part && part.type === "reasoning");
  expect(reasoning).toMatchObject([
    {
      text: "Thinking.",
      providerOptions: { anthropic: { signature: "sig-1" } },
    },
  ]);
});

test("a crash after an execute tool finished, before its result was saved, resumes it with the same toolCallId and key", async () => {
  attempts.push(
    dying(
      scripted(toolStep([{ id: "c1", tool: "charge" }])),
      savesRole("tool"),
    ),
  );
  const done = scripted("Done.");
  attempts.push((ctx, ids) => run(ctx, done, ids));
  const { callRow, retried } = await submitted();
  await retried();
  const key = `${await callRow("c1")}:c1`;
  expect(keys).toEqual([`charged ${key}`, `resumed ${key}`]);
  expect(done.doStreamCalls).toHaveLength(1);
  expect(promptOf(done, 0)).toContain("charged");
});

test("a crash after an execute tool without resume finished, before its result was saved, tells the model its outcome is unknown", async () => {
  attempts.push(
    dying(
      scripted(toolStep([{ id: "l1", tool: "lookup" }])),
      savesRole("tool"),
    ),
  );
  const done = scripted("Done.");
  attempts.push((ctx, ids) => run(ctx, done, ids));
  const { callRow, retried } = await submitted();
  await retried();
  expect(keys).toEqual([`looked up ${await callRow("l1")}:l1`]);
  expect(done.doStreamCalls).toHaveLength(1);
  expect(promptOf(done, 0)).toMatch(/l1.*outcome is unknown/);
});

test("a mutation tool whose job crashes after its mutation committed runs it exactly once under its key, and a call with its id in the next step gets another key", async () => {
  attempts.push(async (ctx, ids) => {
    const committed = gate();
    const runMutation = (async (ref: never, args: object) => {
      const result = await ctx.runMutation(ref, args as never);
      if ("handle" in args) {
        committed.open();
        await forever;
      }
      return result;
    }) as ActionCtx["runMutation"];
    run(
      { ...ctx, runMutation },
      scripted(
        toolStep([{ id: "call_0", tool: "place", input: { item: "book" } }]),
      ),
      ids,
    ).catch(() => {});
    await committed.opened;
    throw new Error("crashed");
  });
  const done = scripted(
    toolStep([{ id: "call_0", tool: "place", input: { item: "pen" } }]),
    "Done.",
  );
  attempts.push((ctx, ids) => run(ctx, done, ids));
  const { orders, callRow, retried } = await submitted();
  await retried();
  const key = `${await callRow("call_0")}:call_0`;
  const [book, pen] = await orders();
  expect([book.item, book.key, pen.item]).toEqual(["book", key, "pen"]);
  expect(pen.key).toMatch(/:call_0$/);
  expect(pen.key).not.toBe(key);
  expect(keys).toEqual([key, key, pen.key]);
  expect(promptOf(done, 0)).toContain("placed book");
});

test("a crash before a step's execute calls were recorded asks the model for the step again, and its tools run only once recorded", async () => {
  // Dies at the step's first write after its model call: its record, or on a
  // runner that records nothing, the step's save.
  attempts.push(
    dying(
      scripted(toolStep([{ id: "c1", tool: "charge" }])),
      (args: { step?: unknown }) =>
        args.step !== undefined || savesRole("tool")(args),
    ),
  );
  const again = scripted(toolStep([{ id: "c2", tool: "charge" }]), "Done.");
  attempts.push((ctx, ids) => run(ctx, again, ids));
  const { callRow, retried } = await submitted();
  await retried();
  expect(again.doStreamCalls).toHaveLength(2);
  expect(keys).toEqual([`charged ${await callRow("c2")}:c2`]);
});

test("a call that needs approval survives a crash before its step was saved, and waits for its approval, which runs it once", async () => {
  attempts.push(
    dying(
      scripted(
        toolStep([
          { id: "a1", tool: "approvedPlace", input: { item: "book" } },
        ]),
      ),
      (args: { messages?: unknown }) =>
        JSON.stringify(args.messages ?? []).includes("tool-approval-request"),
    ),
  );
  const replayed = scripted("Not asked.");
  attempts.push(async (ctx, ids) => {
    await agent
      .generateText(
        ctx,
        { threadId: ids.threadId },
        { ...ids, model: replayed },
      )
      .then(() => {});
  });
  const done = scripted("Done.");
  attempts.push((ctx, ids) => run(ctx, done, ids));
  const { t, ids, orders, docs, answered } = await submitted();
  await t.finishAllScheduledFunctions(() => {});
  expect(
    await t.mutation((ctx) => agent.retryGeneration(ctx, ids)),
  ).not.toBeNull();
  await t.finishAllScheduledFunctions(() => {});
  expect(replayed.doGenerateCalls).toHaveLength(0);
  expect(await t.mutation((ctx) => agent.retryGeneration(ctx, ids))).toBeNull();
  const approvalId = (await docs())
    .flatMap((m): { type: string; approvalId?: string }[] =>
      Array.isArray(m.message?.content) ? m.message.content : [],
    )
    .find((p) => p.type === "tool-approval-request")!.approvalId!;
  await t.mutation((ctx) =>
    agent.approveToolCall(ctx, {
      threadId: ids.threadId,
      approvalId,
      generate,
    }),
  );
  await t.finishAllScheduledFunctions(() => {});
  await until(answered);
  expect((await orders()).map((o) => o.item)).toEqual(["book"]);
  expect((await orders())[0].key).toMatch(/:a1$/);
  expect(promptOf(done, 0)).toContain("placed book");
});

test("an approved call and a call with its id in the step after it get different keys, and never each other's result", async () => {
  attempts.push((ctx, ids) =>
    run(
      ctx,
      scripted(
        toolStep([
          { id: "call_0", tool: "approvedPlace", input: { item: "book" } },
        ]),
      ),
      ids,
    ),
  );
  const next = scripted(
    toolStep([{ id: "call_0", tool: "place", input: { item: "pen" } }]),
    "Done.",
  );
  attempts.push((ctx, ids) => run(ctx, next, ids));
  const { t, ids, docs, orders, callRow, answered } = await submitted();
  await t.finishAllScheduledFunctions(() => {});
  const approvalId = (await docs())
    .flatMap((m): { type: string; approvalId?: string }[] =>
      Array.isArray(m.message?.content) ? m.message.content : [],
    )
    .find((p) => p.type === "tool-approval-request")!.approvalId!;
  await t.mutation((ctx) =>
    agent.approveToolCall(ctx, {
      threadId: ids.threadId,
      approvalId,
      generate,
    }),
  );
  await t.finishAllScheduledFunctions(() => {});
  await until(answered);
  const requested = await callRow("call_0");
  const [book, pen] = await orders();
  expect([book.item, pen.item]).toEqual(["book", "pen"]);
  expect(book.key).toBe(`${requested}:call_0`);
  expect(pen.key).toMatch(/:call_0$/);
  expect(pen.key).not.toBe(book.key);
});

test("a crash after a mutation committed in the step after an approval replays that step from its record", async () => {
  attempts.push((ctx, ids) =>
    run(
      ctx,
      scripted(
        toolStep([
          { id: "a1", tool: "approvedPlace", input: { item: "book" } },
        ]),
      ),
      ids,
    ),
  );
  attempts.push(async (ctx, ids) => {
    const committed = gate();
    const runMutation = (async (ref: never, args: object) => {
      const result = await ctx.runMutation(ref, args as never);
      if ((args as { args?: { item?: string } }).args?.item === "pen") {
        committed.open();
        await forever;
      }
      return result;
    }) as ActionCtx["runMutation"];
    run(
      { ...ctx, runMutation },
      scripted(toolStep([{ id: "p1", tool: "place", input: { item: "pen" } }])),
      ids,
    ).catch(() => {});
    await committed.opened;
    throw new Error("crashed");
  });
  const done = scripted("Done.");
  attempts.push((ctx, ids) => run(ctx, done, ids));
  const { t, ids, docs, orders, answered } = await submitted();
  await t.finishAllScheduledFunctions(() => {});
  const approvalId = (await docs())
    .flatMap((m): { type: string; approvalId?: string }[] =>
      Array.isArray(m.message?.content) ? m.message.content : [],
    )
    .find((p) => p.type === "tool-approval-request")!.approvalId!;
  await t.mutation((ctx) =>
    agent.approveToolCall(ctx, {
      threadId: ids.threadId,
      approvalId,
      generate,
    }),
  );
  await t.finishAllScheduledFunctions(() => {});
  await until(
    async () => !!(await t.mutation((ctx) => agent.retryGeneration(ctx, ids))),
  );
  await t.finishAllScheduledFunctions(() => {});
  await until(answered);
  expect((await orders()).map((o) => o.item)).toEqual(["book", "pen"]);
  expect(promptOf(done, 0)).toContain("placed pen");
});

test("a generation that skips the prepareStep it was given never treats its model's calls as replays", async () => {
  holds.add("c1");
  const first = scripted(toolStep([{ id: "c1", tool: "charge" }]));
  attempts.push(async (ctx, ids) => {
    run(ctx, first, ids).catch(() => {});
    await charging.opened;
    throw new Error("crashed");
  });
  const fresh = scripted(toolStep([{ id: "c1", tool: "charge" }]), "Done.");
  const ran = gate();
  attempts.push(async (ctx, ids) => {
    const { args } = await agent.start(
      ctx,
      { promptMessageId: ids.promptMessageId, model: fresh },
      { threadId: ids.threadId },
    );
    await streamText({
      ...args,
      prepareStep: undefined,
    } as never).consumeStream();
    ran.open();
  });
  const { t, ids } = await submitted();
  await t.finishAllScheduledFunctions(() => {});
  expect(
    await t.mutation((ctx) => agent.retryGeneration(ctx, ids)),
  ).not.toBeNull();
  await t.finishAllScheduledFunctions(() => {});
  await ran.opened;
  expect(fresh.doStreamCalls).toHaveLength(2);
  expect(keys.map((key) => key.split(" ")[0])).toEqual(["charged", "charged"]);
});

test("a generation that skips the prepareStep it was given runs its model's mutation calls, not the results of the step it replaced", async () => {
  attempts.push(
    dying(
      scripted(
        toolStep([{ id: "p1", tool: "place", input: { item: "book" } }]),
      ),
      (args) => JSON.stringify(args).includes("placed book"),
    ),
  );
  const ran = gate();
  attempts.push(async (ctx, ids) => {
    const { args } = await agent.start(
      ctx,
      {
        promptMessageId: ids.promptMessageId,
        model: scripted(
          toolStep([{ id: "p1", tool: "place", input: { item: "pen" } }]),
          "Done.",
        ),
      },
      { threadId: ids.threadId },
    );
    await streamText({
      ...args,
      prepareStep: undefined,
    } as never).consumeStream();
    ran.open();
  });
  const { t, ids, orders } = await submitted();
  await t.finishAllScheduledFunctions(() => {});
  expect(
    await t.mutation((ctx) => agent.retryGeneration(ctx, ids)),
  ).not.toBeNull();
  await t.finishAllScheduledFunctions(() => {});
  await ran.opened;
  expect((await orders()).map((o) => o.item)).toEqual(["book", "pen"]);
});

test("a call the toolApproval option asks approval for survives a crash before its step was saved, and waits for its approval, which runs it once", async () => {
  const toolApproval = { place: "user-approval" };
  attempts.push(
    dying(
      scripted(
        toolStep([{ id: "a1", tool: "place", input: { item: "book" } }]),
      ),
      (args: { messages?: unknown }) =>
        JSON.stringify(args.messages ?? []).includes("tool-approval-request"),
      { toolApproval },
    ),
  );
  const replayed = scripted("Not asked.");
  attempts.push((ctx, ids) => run(ctx, replayed, ids, { toolApproval }));
  const done = scripted("Done.");
  attempts.push((ctx, ids) => run(ctx, done, ids, { toolApproval }));
  const { t, ids, orders, docs, answered } = await submitted();
  await t.finishAllScheduledFunctions(() => {});
  expect(
    await t.mutation((ctx) => agent.retryGeneration(ctx, ids)),
  ).not.toBeNull();
  await t.finishAllScheduledFunctions(() => {});
  expect(replayed.doStreamCalls).toHaveLength(0);
  expect(await t.mutation((ctx) => agent.retryGeneration(ctx, ids))).toBeNull();
  const approvalId = (await docs())
    .flatMap((m): { type: string; approvalId?: string }[] =>
      Array.isArray(m.message?.content) ? m.message.content : [],
    )
    .find((p) => p.type === "tool-approval-request")!.approvalId!;
  await t.mutation((ctx) =>
    agent.approveToolCall(ctx, {
      threadId: ids.threadId,
      approvalId,
      generate,
    }),
  );
  await t.finishAllScheduledFunctions(() => {});
  await until(answered);
  expect((await orders()).map((o) => o.item)).toEqual(["book"]);
  expect(promptOf(done, 0)).toContain("placed book");
});

test("a durable step's generator tool still streams its preliminary results", async () => {
  const go = gate();
  placeGo = go.opened;
  const model = scripted(toolStep([{ id: "n1", tool: "count" }]), "Done.");
  attempts.push((ctx, ids) => run(ctx, model, ids));
  const { t, ids, answered } = await submitted();
  const streamed = async () => {
    const streams = await t.query((ctx) =>
      ctx.runQuery(components.agent.streams.list, { threadId: ids.threadId }),
    );
    return JSON.stringify(
      await t.query((ctx) =>
        ctx.runQuery(components.agent.streams.listDeltas, {
          threadId: ids.threadId,
          cursors: streams.map((s) => ({ streamId: s.streamId, cursor: 0 })),
        }),
      ),
    );
  };
  await until(async () => (await streamed()).includes("counting"));
  expect(await streamed()).not.toContain("counted");
  go.open();
  await t.finishAllScheduledFunctions(() => {});
  await until(answered);
  expect(promptOf(model, 1)).toContain("counted");
});

test("a replaced job's tool mutation is refused", async () => {
  const go = gate();
  placeGo = go.opened;
  attempts.push((ctx, ids) =>
    run(
      ctx,
      scripted(
        toolStep([{ id: "p1", tool: "place", input: { item: "book" } }]),
      ),
      ids,
    ).catch(() => {}),
  );
  const { t, ids, orders } = await submitted();
  const job = t.finishAllScheduledFunctions(() => {});
  await placing.opened;
  await t.mutation((ctx) =>
    agent.abortGeneration(ctx, { ...ids, reason: "Stopped" }),
  );
  go.open();
  await job;
  expect(keys).toHaveLength(1);
  expect(await orders()).toEqual([]);
});

test("a plain generation's mutation tool runs its mutation, keyed by the step's message", async () => {
  const t = createTest();
  const threadId = await t.mutation((ctx) =>
    createThread(ctx, components.agent, {}),
  );
  const model = scripted(
    toolStep([{ id: "p1", tool: "place", input: { item: "book" } }]),
    "Done.",
  );
  await t.action((ctx) =>
    agent
      .streamText(ctx, { threadId }, { prompt: "Go.", model }, deltas)
      .then((result) => result.consumeStream()),
  );
  const { page } = await t.query((ctx) =>
    ctx.runQuery(components.agent.messages.listMessagesByThreadId, {
      threadId,
      order: "asc",
    }),
  );
  const call = (page as MessageDoc[]).find(
    (m) => m.message?.role === "assistant" && m.tool,
  )!;
  expect(
    (await t.run((ctx) => ctx.db.query("orders").collect())).map((o) => o.key),
  ).toEqual([`${call._id}:p1`]);
  expect(model.doStreamCalls).toHaveLength(2);
});

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
  expect([reply.status, reply.abort, reply.text]).toEqual([
    "success",
    { reason: "Stopped" },
    "Hello",
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
