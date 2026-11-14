/// <reference types="vite/client" />

import { omit, pick } from "convex-helpers";
import type { FunctionArgs } from "convex/server";
import { convexTest } from "convex-test";
import { convexToJson, getDocumentSize, type Value } from "convex/values";
import { describe, expect, test } from "vitest";
import { listMessages } from "../client/messages.js";
import { extractText, isTool, withDerivedReasoning } from "../shared.js";
import type { Message, MessageDoc } from "../validators.js";
import { fetchContextMessages } from "../vercel/client/search.js";
import { api } from "./_generated/api.js";
import type { ComponentApi } from "./_generated/component.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import schema from "./schema.js";
import { initConvexTest, modules } from "./setup.test.js";

const component = api as unknown as ComponentApi;
// Enforces Convex's transaction limits, like 4,096 index ranges read.
const limited = () => convexTest({ schema, modules, transactionLimits: true });

type T = ReturnType<typeof initConvexTest>;
type Ctx = Parameters<Parameters<T["run"]>[0]>[0];
type Sent = FunctionArgs<typeof api.messages.addMessages>["messages"][number];
type Options = Record<string, Record<string, unknown>>;
type PaginationResult = Awaited<ReturnType<typeof listMessages>>;

const METADATA = [
  "providerOptions",
  "usage",
  "providerMetadata",
  "sources",
  "warnings",
  "reasoning",
  "reasoningDetails",
] as const;
// What the model doesn't read. Reasoning is derived from content on any read.
const RESULT: (keyof MessageDoc)[] = [
  "providerOptions",
  "usage",
  "providerMetadata",
  "sources",
  "warnings",
];

let seed = 7;
function words(chars: number) {
  const vocabulary = "the agent thread message context query index tool result";
  let out = "";
  while (out.length < chars) {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    const list = vocabulary.split(" ");
    out += list[seed % list.length] + " ";
  }
  return out.slice(0, chars);
}
const blob = (chars: number) =>
  "Zm9v".repeat(Math.ceil(chars / 4)).slice(0, chars);

const openaiUsage = {
  promptTokens: 2412,
  completionTokens: 812,
  totalTokens: 3224,
  reasoningTokens: 0,
  cachedInputTokens: 1920,
  nonCachedInputTokens: 492,
  textOutputTokens: 812,
  raw: {
    input_tokens: 2412,
    input_tokens_details: { cached_tokens: 1920 },
    output_tokens: 812,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 3224,
  },
};
const anthropicUsage = {
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 4,
  },
  cache_creation_input_tokens: 412,
  cache_read_input_tokens: 5120,
  input_tokens: 18,
  output_tokens: 734,
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: "standard",
};
const openai = {
  model: "gpt-4.1",
  provider: "openai.responses",
  providerMetadata: {
    openai: { responseId: `resp_${blob(48)}`, serviceTier: "default" },
  },
  usage: openaiUsage,
  finishReason: "stop" as const,
};
const anthropic = (finishReason: "stop" | "tool-calls") => ({
  model: "claude-sonnet-4-5",
  provider: "anthropic.messages",
  providerMetadata: {
    anthropic: { container: null, stopSequence: null, usage: anthropicUsage },
  },
  usage: {
    cacheWriteInputTokens: 412,
    cachedInputTokens: 5120,
    completionTokens: 734,
    nonCachedInputTokens: 18,
    promptTokens: 5550,
    totalTokens: 6284,
    raw: anthropicUsage,
  },
  finishReason,
});

const prompt = (): Sent => ({
  message: { role: "user", content: `needle ${words(160)}` },
});
const text = (chars: number, providerOptions?: Options) => ({
  type: "text" as const,
  text: `needle ${words(chars)}`,
  ...(providerOptions && { providerOptions }),
});
const reasoning = (chars: number, providerOptions: Options) => ({
  type: "reasoning" as const,
  text: words(chars),
  providerOptions,
});
const assistant = (content: Message["content"], fields: object): Sent =>
  ({ message: { role: "assistant", content }, ...fields }) as Sent;
let call = 0;
function toolStep(output: unknown): Sent[] {
  const toolCallId = `toolu_${call++}`;
  return [
    assistant(
      [
        reasoning(800, { anthropic: { signature: blob(1200) } }),
        {
          type: "tool-call",
          toolCallId,
          toolName: "search",
          input: { q: "q" },
        },
      ],
      anthropic("tool-calls"),
    ),
    {
      message: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "search",
            output: { type: "json", value: output as never },
          },
        ],
      },
    },
  ];
}

/** One turn of each kind of thread, sized like what providers return. */
const turns: Record<string, () => Sent[]> = {
  "plain chat": () => [
    prompt(),
    assistant([text(1200, { openai: { itemId: `msg_${blob(48)}` } })], openai),
  ],
  "encrypted reasoning": () => [
    prompt(),
    assistant(
      [
        reasoning(900, {
          openai: {
            itemId: `rs_${blob(48)}`,
            reasoningEncryptedContent: blob(6000),
          },
        }),
        text(1200, { openai: { itemId: `msg_${blob(48)}` } }),
      ],
      { ...openai, model: "gpt-5" },
    ),
  ],
  "tools with large results": () => [
    prompt(),
    ...toolStep({ results: words(18_000) }),
    ...toolStep({ text: words(50_000) }),
    assistant(
      [reasoning(400, { anthropic: { signature: blob(1200) } }), text(1500)],
      anthropic("stop"),
    ),
  ],
  "tool calls and short answers": () => {
    const toolCallId = `call_${call++}`;
    return [
      prompt(),
      assistant(
        [
          {
            type: "tool-call",
            toolCallId,
            toolName: "search",
            input: { q: "q" },
          },
        ],
        { ...openai, finishReason: "tool-calls" },
      ),
      {
        message: {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId,
              toolName: "search",
              output: { type: "text", value: words(200) },
            },
          ],
        },
      },
      assistant([text(20)], openai),
    ];
  },
  "grounded answers": () => [
    prompt(),
    assistant(
      [
        reasoning(1200, { google: { thoughtSignature: blob(1800) } }),
        text(1400, { google: { thoughtSignature: blob(600) } }),
      ],
      {
        model: "gemini-2.5-flash",
        provider: "google.generative-ai",
        finishReason: "stop",
        usage: {
          promptTokens: 1540,
          completionTokens: 1580,
          totalTokens: 3120,
        },
        providerMetadata: {
          google: {
            groundingMetadata: {
              groundingChunks: Array.from({ length: 8 }, (_, i) => ({
                web: { title: `site${i}.example.com`, uri: blob(283) },
              })),
              searchEntryPoint: { renderedContent: words(6000) },
              webSearchQueries: ["convex agent cost"],
            },
          },
        },
        sources: Array.from({ length: 8 }, (_, i) => ({
          type: "source",
          sourceType: "url",
          id: `s${i}`,
          title: `site${i}.example.com`,
          url: blob(283),
        })),
      },
    ),
  ],
  "images and files": () => [
    {
      message: {
        role: "user",
        content: [
          { type: "text", text: "needle what is in these?" },
          {
            type: "image",
            image: new ArrayBuffer(40_000),
            mediaType: "image/png",
          },
          { type: "file", data: blob(20_000), mediaType: "application/pdf" },
        ],
      },
    },
    assistant([text(800)], openai),
  ],
};

// Enough result metadata to leave the row, and enough text that the row and
// payload read no more than the message whole.
const splitAnswer = () =>
  assistant([text(400)], {
    usage: openaiUsage,
    providerMetadata: { google: { groundingMetadata: words(1_700) } },
  });

async function payloadCount(t: T) {
  return t.run(
    async (ctx) => (await ctx.db.query("messagePayloads").collect()).length,
  );
}

async function createThread(t: T, userId?: string) {
  const thread = await t.mutation(api.threads.createThread, { userId });
  return thread._id as Id<"threads">;
}

async function save(t: T, threadId: Id<"threads">, turns: Sent[][]) {
  const saved: MessageDoc[] = [];
  for (const messages of turns) {
    const result = await t.mutation(api.messages.addMessages, {
      threadId,
      messages,
    });
    saved.push(...result.messages);
  }
  return saved;
}

/** Inserts the turns as rows the way releases before payloads saved them. */
async function saveWhole(t: T, threadId: Id<"threads">, turns: Sent[][]) {
  await t.run(async (ctx) => {
    let order = -1;
    let stepOrder = 0;
    for (const message of turns.flat()) {
      if (message.message.role === "user") {
        order++;
        stepOrder = 0;
      } else {
        stepOrder++;
      }
      await ctx.db.insert("messages", {
        ...message,
        threadId,
        order,
        stepOrder,
        status: message.status ?? "success",
        tool: isTool(message.message),
        text: extractText(message.message),
      } as Omit<Doc<"messages">, "_id" | "_creationTime">);
    }
  });
}

async function cost<R>(t: T, fn: (ctx: Ctx) => Promise<R>) {
  return t.run(async (ctx) => {
    const before = await ctx.meta.getTransactionMetrics();
    const result = await fn(ctx);
    const after = await ctx.meta.getTransactionMetrics();
    return {
      result,
      bytesRead: after.bytesRead.used - before.bytesRead.used,
      documentsRead: after.documentsRead.used - before.documentsRead.used,
      bytesWritten: after.bytesWritten.used - before.bytesWritten.used,
    };
  });
}

const page = (numItems: number) => ({ cursor: null, numItems });

/** Each read and save path an Agent app runs on every turn. */
const paths = {
  context: (threadId: Id<"threads">) => (ctx: Ctx) =>
    fetchContextMessages(ctx, component, {
      threadId,
      userId: undefined,
      contextOptions: { recentMessages: 100 },
    }),
  page: (threadId: Id<"threads">) => (ctx: Ctx) =>
    listMessages(ctx, component, { threadId, paginationOpts: page(20) }),
  textPage: (threadId: Id<"threads">, split: boolean) => (ctx: Ctx) =>
    listMessages(ctx, component, {
      threadId,
      paginationOpts: page(20),
      ...(split ? { textOnly: true } : { excludeToolMessages: true }),
    }),
  pageWithoutTools: (threadId: Id<"threads">) => (ctx: Ctx) =>
    listMessages(ctx, component, {
      threadId,
      paginationOpts: page(20),
      excludeToolMessages: true,
    }),
  search: (threadId: Id<"threads">) => (ctx: Ctx) =>
    ctx.runQuery(api.messages.textSearch, {
      threadId,
      text: "needle",
      limit: 10,
    }),
  save: (threadId: Id<"threads">) => (ctx: Ctx) =>
    ctx.runMutation(api.messages.addMessages, {
      threadId,
      messages: [{ message: { role: "assistant", content: "next step" } }],
    }),
  stepSave: (threadId: Id<"threads">) => async (ctx: Ctx) => {
    const [promptMessage, pending] = (
      await ctx.runMutation(api.messages.addMessages, {
        threadId,
        messages: [
          prompt(),
          { message: { role: "assistant", content: [] }, status: "pending" },
        ],
      })
    ).messages;
    return ctx.runMutation(api.messages.addMessages, {
      threadId,
      promptMessageId: promptMessage._id as Id<"messages">,
      pendingMessageId: pending._id as Id<"messages">,
      messages: toolStep({ results: words(2_000) }),
    });
  },
};

const exact = (doc: object) =>
  convexToJson(omit(doc as MessageDoc, ["_id", "_creationTime"]) as Value);

describe("each hot path reads no more than rows saved whole", () => {
  for (const [name, turn] of Object.entries(turns)) {
    test(name, async () => {
      const t = initConvexTest();
      const sent = Array.from({ length: 6 }, turn);
      const split = await createThread(t);
      const whole = await createThread(t);
      await save(t, split, sent);
      await saveWhole(t, whole, sent);
      for (const [path, fn] of Object.entries(paths)) {
        const run = fn as (
          threadId: Id<"threads">,
          split: boolean,
        ) => (ctx: Ctx) => Promise<unknown>;
        const [a, b] = [
          await cost(t, run(split, true)),
          await cost(t, run(whole, false)),
        ];
        const where = `${name}: ${path}`;
        expect(a.bytesRead, where).toBeLessThanOrEqual(b.bytesRead);
        expect(a.documentsRead, where).toBeLessThanOrEqual(
          path === "page" || path === "pageWithoutTools"
            ? 2 * b.documentsRead
            : b.documentsRead,
        );
      }
    });
  }
});

test("context, search and saves read none of an answer's result metadata", async () => {
  const t = initConvexTest();
  const threadId = await createThread(t);
  const heavy = { google: { groundingMetadata: words(50_000) } };
  await save(
    t,
    threadId,
    Array.from({ length: 10 }, () => [
      prompt(),
      assistant([text(300)], { ...openai, providerMetadata: heavy }),
    ]),
  );
  const context = await cost(t, paths.context(threadId));
  expect(context.result).toHaveLength(20);
  expect(context.bytesRead).toBeLessThan(50_000);
  for (const doc of context.result) {
    for (const field of METADATA) {
      expect(doc, field).not.toHaveProperty(field);
    }
  }
  const search = await cost(t, paths.search(threadId));
  expect(search.result.length).toBeGreaterThan(0);
  expect(search.bytesRead).toBeLessThan(50_000);
  expect((await cost(t, paths.save(threadId))).bytesRead).toBeLessThan(50_000);
  expect((await cost(t, paths.stepSave(threadId))).bytesRead).toBeLessThan(
    50_000,
  );
  const full = await cost(t, paths.page(threadId));
  expect(full.bytesRead).toBeGreaterThan(8 * 50_000);
  expect(
    full.result.page.filter((m) => m.providerMetadata?.google),
  ).toHaveLength(8);
});

test("answers with a little result metadata keep it on the row, so a full page reads no more documents", async () => {
  const t = initConvexTest();
  const sent = Array.from({ length: 10 }, () => [
    prompt(),
    assistant([text(300)], openai),
  ]);
  const split = await createThread(t);
  const whole = await createThread(t);
  await save(t, split, sent);
  await saveWhole(t, whole, sent);
  expect(await payloadCount(t)).toBe(0);
  const [a, b] = [
    await cost(t, paths.page(split)),
    await cost(t, paths.page(whole)),
  ];
  expect(a.documentsRead).toBe(b.documentsRead);
  expect(a.bytesRead).toBeLessThan(b.bytesRead);
  await save(t, split, [[prompt(), splitAnswer()]]);
  expect(await payloadCount(t)).toBe(1);
});

test("context holds each message as saved, and text pages its role and text", async () => {
  const t = initConvexTest();
  const threadId = await createThread(t);
  const sent = Object.values(turns).map((turn) => turn());
  const saved = await save(t, threadId, sent);
  const context = await t.run(paths.context(threadId));
  expect(context.map(exact)).toEqual(saved.map((m) => exact(omit(m, RESULT))));
  const { page: text } = await t.run(paths.textPage(threadId, true));
  const nonTool = saved.filter((m) => !m.tool).reverse();
  expect(text.map(exact)).toEqual(
    nonTool.map((m) =>
      exact({
        ...omit(m, [...METADATA, "message"]),
        message: { role: m.message!.role, content: m.text ?? "" },
      }),
    ),
  );
});

/**
 * Messages whose text is easy to split wrongly: several text parts, empty
 * ones, spaces at either end or doubled, text between other parts and parts
 * with provider options. Some carry result metadata.
 */
function tricky(count: number): Sent[] {
  let state = count;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
  const pick = <V>(values: readonly V[]) =>
    values[Math.floor(next() * values.length)];
  const pieces = ["", " ", "  ", "a", "one two", " lead", "trail ", "a  b"];
  const someText = () =>
    Array.from({ length: Math.floor(next() * 4) }, () =>
      pick([...pieces, "line\nbreak", "é ü 🧪", "x".repeat(300)]),
    ).join(pick(["", " "]));
  const options = () =>
    next() < 0.4 ? { providerOptions: { p: { id: someText() } } } : {};
  const part = {
    text: () => ({ type: "text", text: someText(), ...options() }),
    reasoning: () => ({ type: "reasoning", text: someText(), ...options() }),
    image: () => ({ type: "image", image: new ArrayBuffer(3) }),
    file: () => ({ type: "file", data: someText(), mediaType: "text/plain" }),
    call: () => ({
      type: "tool-call",
      toolCallId: "c",
      toolName: "t",
      input: { q: someText() },
    }),
  };
  const parts = (...kinds: (keyof typeof part)[]) =>
    Array.from({ length: Math.floor(next() * 6) }, () => part[pick(kinds)]());
  const messages = [
    () => ({ role: "user", content: someText() }),
    () => ({ role: "user", content: parts("text", "text", "image", "file") }),
    () => ({ role: "assistant", content: someText() }),
    () => ({
      role: "assistant",
      content: parts("text", "text", "reasoning", "call", "file"),
    }),
    () => ({ role: "system", content: someText() }),
  ];
  return Array.from({ length: count }, () => ({
    message: {
      ...pick(messages)(),
      ...(next() < 0.2 && { providerOptions: { p: { m: 1 } } }),
    } as Message,
    ...(next() < 0.4 && omit(openai, ["finishReason"])),
  }));
}

async function readAll(t: T, threadId: Id<"threads">) {
  const all = await t.query(api.messages.listMessagesByThreadId, {
    threadId,
    order: "asc",
    paginationOpts: page(10_000),
  });
  const byId = await t.query(api.messages.getMessagesByIds, {
    messageIds: all.page.map((m) => m._id as Id<"messages">),
  });
  expect(byId).toEqual(all.page);
  return all.page;
}

const KEYS = ["threadId", "status", "tool", "order", "stepOrder"] as const;

// Each payload belongs to one message and is keyed by its position, and
// nothing outlives its message.
async function expectConsistentStorage(t: T) {
  await t.run(async (ctx) => {
    const rows = await ctx.db.query("messages").collect();
    const linked = rows.flatMap((m) => (m.payloadId ? [m.payloadId] : []));
    const payloads = await ctx.db.query("messagePayloads").collect();
    expect(new Set(linked).size).toBe(linked.length);
    expect(payloads.map((p) => p._id).sort()).toEqual(linked.sort());
    for (const row of rows.filter((m) => m.payloadId)) {
      const payload = payloads.find((p) => p._id === row.payloadId)!;
      expect(pick(payload, [...KEYS])).toEqual(pick(row, [...KEYS]));
    }
  });
}

describe("full reads return each message as saved", () => {
  const sent = [
    ...tricky(80),
    ...Object.values(turns).flatMap((turn) => turn()),
  ];
  for (const hideFromUserIdSearch of [false, true]) {
    test(
      hideFromUserIdSearch ? "hidden from search" : "searchable",
      async () => {
        const t = initConvexTest();
        const threadId = await createThread(t, "u");
        const { messages: saved } = await t.mutation(api.messages.addMessages, {
          threadId,
          messages: sent,
          hideFromUserIdSearch,
        });
        saved.forEach((m, i) => {
          expect(exact(m.message!)).toEqual(exact(sent[i].message));
          expect(m.text).toBe(
            hideFromUserIdSearch ? undefined : extractText(sent[i].message),
          );
          expect(m).toMatchObject(omit(sent[i], ["message"]));
        });
        expect((await readAll(t, threadId)).map(exact)).toEqual(
          saved.map(exact),
        );
        await expectConsistentStorage(t);
      },
    );
  }

  test("rows saved whole, before payloads", async () => {
    const t = initConvexTest();
    const whole = await createThread(t);
    const split = await createThread(t);
    await saveWhole(t, whole, [sent]);
    await save(t, split, [sent]);
    const strip = (docs: MessageDoc[]) =>
      docs.map((m) => exact(omit(m, ["threadId", "order", "stepOrder"])));
    expect(strip(await readAll(t, whole))).toEqual(
      strip(await readAll(t, split)),
    );
  });
});

describe("writes keep each message whole", () => {
  async function setup() {
    const t = initConvexTest();
    const threadId = await createThread(t, "u");
    const sent = [...tricky(30), ...turns["tools with large results"]()];
    const saved = await save(t, threadId, [sent]);
    return { t, threadId, sent, saved };
  }

  test("updates", async () => {
    const { t, threadId, sent, saved } = await setup();
    const expected = [];
    for (const [i, doc] of saved.entries()) {
      const { message } = sent[(i + 7) % sent.length];
      const patch = [
        { status: "failed" as const, error: "nope" },
        { providerOptions: { p: { updated: true } } },
        { message },
        { message, model: "m2", finishReason: "length" as const },
      ][i % 4];
      const updated = await t.mutation(api.messages.updateMessage, {
        messageId: doc._id as Id<"messages">,
        patch,
      });
      const next = withDerivedReasoning({
        ...omit(doc, ["reasoning", "reasoningDetails"]),
        ...patch,
        ...(patch.message && {
          tool: isTool(patch.message),
          text: extractText(patch.message),
        }),
      });
      expect(exact(updated)).toEqual(exact(next));
      expected.push(next);
    }
    expect((await readAll(t, threadId)).map(exact)).toEqual(
      expected.map(exact),
    );
    await expectConsistentStorage(t);
  });

  test("clones, and deletes of the source", async () => {
    const { t, threadId, saved } = await setup();
    const targetThreadId = await createThread(t);
    await t.action(api.messages.cloneThread, {
      sourceThreadId: threadId,
      targetThreadId,
      batchSize: 7,
    });
    await t.action(api.threads.deleteAllForThreadIdSync, { threadId });
    await expectConsistentStorage(t);
    const strip = (docs: MessageDoc[]) =>
      docs.map((m) => exact(omit(m, ["threadId"])));
    expect(strip(await readAll(t, targetThreadId))).toEqual(strip(saved));
  });

  test("deletes in the middle of a paginated read", async () => {
    const { t, threadId, saved } = await setup();
    const first = await t.query(api.messages.listMessagesByThreadId, {
      threadId,
      order: "asc",
      paginationOpts: page(10),
    });
    await t.mutation(api.messages.deleteByIds, {
      messageIds: saved.slice(5, 20).map((m) => m._id as Id<"messages">),
    });
    const rest = await t.query(api.messages.listMessagesByThreadId, {
      threadId,
      order: "asc",
      paginationOpts: { cursor: first.continueCursor, numItems: 1_000 },
    });
    expect([...first.page, ...rest.page].map(exact)).toEqual(
      [...saved.slice(0, 10), ...saved.slice(20)].map(exact),
    );
    await expectConsistentStorage(t);
  });

  test("a pending message replaced by its step, and concurrent saves and updates", async () => {
    const t = initConvexTest();
    const threadId = await createThread(t);
    const [promptMessage, pending] = await save(t, threadId, [
      [
        prompt(),
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
    ]);
    const step = toolStep({ results: words(5_000) });
    const [, saved] = await Promise.all([
      t.mutation(api.messages.updateMessage, {
        messageId: promptMessage._id as Id<"messages">,
        patch: { message: { role: "user", content: "needle edited" } },
      }),
      t.mutation(api.messages.addMessages, {
        threadId,
        promptMessageId: promptMessage._id as Id<"messages">,
        pendingMessageId: pending._id as Id<"messages">,
        messages: step,
      }),
      t.mutation(api.messages.addMessages, {
        threadId,
        messages: turns["grounded answers"](),
      }),
    ]);
    expect(saved.messages[0]._id).toBe(pending._id);
    expect(saved.messages.map((m) => exact(m.message!))).toEqual(
      step.map((m) => exact(m.message)),
    );
    const all = await readAll(t, threadId);
    expect(all[0].message).toEqual({ role: "user", content: "needle edited" });
    expect(all).toHaveLength(5);
    await expectConsistentStorage(t);
  });

  test("a step replacing a pending message with metadata, and concurrent steps at one order", async () => {
    const t = initConvexTest();
    const threadId = await createThread(t);
    const [promptMessage, pending] = await save(t, threadId, [
      [
        prompt(),
        {
          message: { role: "assistant", content: [] },
          status: "pending",
          ...openai,
        },
      ],
    ]);
    const promptMessageId = promptMessage._id as Id<"messages">;
    await Promise.all([
      t.mutation(api.messages.addMessages, {
        threadId,
        promptMessageId,
        pendingMessageId: pending._id as Id<"messages">,
        messages: [{ message: { role: "assistant", content: "plain" } }],
      }),
      ...Array.from({ length: 4 }, () =>
        t.mutation(api.messages.addMessages, {
          threadId,
          promptMessageId,
          messages: toolStep({ results: words(3_000) }),
        }),
      ),
    ]);
    const all = await readAll(t, threadId);
    expect(all.map((m) => m.stepOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(all[1]).not.toHaveProperty("usage");
    expect(all.filter((m) => m.usage)).toHaveLength(4);
    await expectConsistentStorage(t);
  });

  test("an update or clone of a row saved whole is read as before", async () => {
    const t = initConvexTest();
    const whole = await createThread(t);
    const sent = [...tricky(20), ...turns["grounded answers"]()];
    await saveWhole(t, whole, [sent]);
    const before = await readAll(t, whole);
    const updated = await Promise.all(
      before.map((doc) =>
        t.mutation(api.messages.updateMessage, {
          messageId: doc._id as Id<"messages">,
          patch: { model: "m2" },
        }),
      ),
    );
    expect(updated.map(exact)).toEqual(
      before.map((m) => exact({ ...m, model: "m2" })),
    );
    const targetThreadId = await createThread(t);
    await t.action(api.messages.cloneThread, {
      sourceThreadId: whole,
      targetThreadId,
    });
    const strip = (docs: MessageDoc[]) =>
      docs.map((m) => exact(omit(m, ["threadId"])));
    expect(strip(await readAll(t, targetThreadId))).toEqual(strip(updated));
    expect(strip(await readAll(t, whole))).toEqual(strip(updated));
    await expectConsistentStorage(t);
  });

  test("finalizing a pending message with text keeps its text", async () => {
    const t = initConvexTest();
    const partial = words(200);
    const threadId = await createThread(t);
    const [, pending] = await save(t, threadId, [
      [
        prompt(),
        {
          message: { role: "assistant", content: partial },
          status: "pending",
        },
      ],
    ]);
    await t.run(async (ctx) => {
      const streamId = await ctx.db.insert("streamingMessages", {
        threadId,
        order: pending.order,
        stepOrder: pending.stepOrder,
        format: "UIMessageChunk",
        state: { kind: "aborted", reason: "interrupted" },
      });
      await ctx.db.insert("streamDeltas", {
        streamId,
        start: 0,
        end: 2,
        parts: [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "streamed" },
        ],
      });
    });
    await t.mutation(api.messages.finalizeMessage, {
      messageId: pending._id as Id<"messages">,
      result: { status: "success" },
    });
    const [final] = await t.query(api.messages.getMessagesByIds, {
      messageIds: [pending._id as Id<"messages">],
    });
    expect(final).toMatchObject({
      status: "success",
      message: { role: "assistant", content: partial },
    });
  });

  test("a pending message with a payload that succeeds or fails is still read with it", async () => {
    const t = initConvexTest();
    const threadId = await createThread(t);
    const pending = (): Sent => ({ ...splitAnswer(), status: "pending" });
    const [, succeeds, fails] = await save(t, threadId, [
      [prompt(), pending(), pending()],
    ]);
    await t.mutation(api.messages.finalizeMessage, {
      messageId: succeeds._id as Id<"messages">,
      result: { status: "success" },
    });
    await t.mutation(api.messages.finalizeMessage, {
      messageId: fails._id as Id<"messages">,
      result: { status: "failed", error: "stopped" },
    });
    const [, restarted] = await save(t, threadId, [[prompt(), pending()]]);
    await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [prompt()],
      failPendingSteps: true,
    });
    expect(await payloadCount(t)).toBe(3);
    await expectConsistentStorage(t);
    const { page: all } = await t.query(api.messages.listMessagesByThreadId, {
      threadId,
      order: "asc",
      paginationOpts: page(20),
    });
    expect(all.filter((m) => m.usage).map((m) => [m._id, m.status])).toEqual([
      [succeeds._id, "success"],
      [fails._id, "failed"],
      [restarted._id, "failed"],
    ]);
  });
});

describe("near the limits", () => {
  test("a row and its payload are each no larger than the message saved whole", async () => {
    const t = initConvexTest();
    const threadId = await createThread(t);
    const sent: Sent[] = [
      prompt(),
      assistant([text(600_000)], openai),
      ...toolStep({ text: words(900_000) }),
      assistant(
        [reasoning(700_000, { anthropic: { signature: blob(100) } }), text(10)],
        anthropic("stop"),
      ),
      assistant(
        Array.from({ length: 8_000 }, (_, i) => ({
          type: "text" as const,
          text: i ? "" : "a",
        })),
        openai,
      ),
    ];
    await save(t, threadId, [sent]);
    const rows = await t.run(async (ctx) =>
      Promise.all(
        (await ctx.db.query("messages").collect()).map(async (row) => ({
          row,
          payload:
            row.payloadId &&
            (await ctx.db.get("messagePayloads", row.payloadId)),
        })),
      ),
    );
    for (const [i, { row, payload }] of rows.entries()) {
      const whole = getDocumentSize({
        ...sent[i],
        ...pick(row, [
          "_id",
          "_creationTime",
          "threadId",
          "order",
          "stepOrder",
        ]),
        ...pick(row, ["status", "tool"]),
        text: extractText(sent[i].message),
      } as Record<string, Value>);
      expect(getDocumentSize(row)).toBeLessThanOrEqual(whole);
      if (payload) {
        expect(getDocumentSize(payload)).toBeLessThanOrEqual(whole);
      }
    }
    // A 600 KB answer saved whole holds its text twice, past 1 MiB.
    expect(getDocumentSize(rows[1].row)).toBeLessThan(700_000);
    expect((await readAll(t, threadId)).map((m) => exact(m.message!))).toEqual(
      sent.map((m) => exact(m.message)),
    );
  });

  test("a full page of more messages than a transaction can get one by one reads in one page", async () => {
    const t = limited();
    const threadId = await createThread(t);
    const answer = splitAnswer();
    const count = 4_200;
    for (let i = 0; i < count; i += 600) {
      await t.mutation(api.messages.addMessages, {
        threadId,
        messages: Array.from(
          { length: Math.min(600, count - i) },
          () => answer,
        ),
      });
    }
    const { page: seen } = await t.query(api.messages.listMessagesByThreadId, {
      threadId,
      order: "asc",
      paginationOpts: page(count),
    });
    expect(await payloadCount(t)).toBe(count);
    expect(seen).toHaveLength(count);
    expect(seen.every((m) => m.usage?.totalTokens === 3224)).toBe(true);
  }, 120_000);

  test("a page charged for its payloads ends where whole rows would", async () => {
    const t = initConvexTest();
    const split = await createThread(t);
    const whole = await createThread(t);
    const sent = Array.from({ length: 10 }, turns["grounded answers"]);
    await save(t, split, sent);
    await saveWhole(t, whole, sent);
    const sizes = await Promise.all(
      [split, whole].map((threadId) =>
        t.query(api.messages.listMessagesByThreadId, {
          threadId,
          order: "asc",
          paginationOpts: {
            cursor: null,
            numItems: 20,
            maximumBytesRead: 40_000,
          },
        }),
      ),
    );
    expect(sizes[0].page.length).toBeLessThanOrEqual(sizes[1].page.length + 1);
    expect(sizes[0].pageStatus).toBe("SplitRequired");
  });
});

describe("pages across rows saved whole and split", () => {
  test("follow their cursors and splits to every message once", async () => {
    const t = initConvexTest();
    const threadId = await createThread(t);
    const sent = Object.values(turns).flatMap((turn) => turn());
    for (let i = 0; i < 4; i++) {
      await saveWhole(t, threadId, [sent]);
      await save(t, threadId, [sent]);
    }
    const all = await readAll(t, threadId);
    for (const maximumBytesRead of [undefined, 30_000, 200_000]) {
      for (const view of ["full", "model", "text"] as const) {
        const seen: string[] = [];
        let cursor: string | null = null;
        let reads = 0;
        do {
          const result: PaginationResult = await t.query(
            api.messages.listMessagesByThreadId,
            {
              threadId,
              order: "asc",
              view,
              paginationOpts: { cursor, numItems: 7, maximumBytesRead },
            },
          );
          if (result.splitCursor && result.pageStatus === "SplitRequired") {
            const half: PaginationResult = await t.query(
              api.messages.listMessagesByThreadId,
              {
                threadId,
                order: "asc",
                view,
                paginationOpts: {
                  cursor,
                  numItems: 7,
                  endCursor: result.splitCursor,
                },
              },
            );
            seen.push(...half.page.map((m) => m._id));
            cursor = result.splitCursor;
          } else {
            seen.push(...result.page.map((m) => m._id));
            cursor = result.isDone ? null : result.continueCursor;
          }
          expect(++reads).toBeLessThan(1_000);
        } while (cursor);
        const expected = all
          .filter((m) => view !== "text" || !m.tool)
          .map((m) => m._id);
        expect(seen, `${view} ${maximumBytesRead}`).toEqual(expected);
      }
    }
  }, 120_000);
});

describe("many messages at once", () => {
  async function seed(
    t: T,
    threadId: Id<"threads">,
    count: number,
    embed = false,
  ) {
    const answer = splitAnswer();
    const vector = Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0));
    for (let i = 0; i < count; i += 500) {
      const n = Math.min(500, count - i);
      await t.mutation(api.messages.addMessages, {
        threadId,
        messages: Array.from({ length: n }, () => answer),
        ...(embed && {
          embeddings: {
            model: "m",
            dimension: 128 as const,
            vectors: Array.from({ length: n }, () => vector),
          },
        }),
      });
    }
    expect(await payloadCount(t)).toBeGreaterThanOrEqual(count);
  }

  test("getMessagesByIds reads 4,000 messages with payloads", async () => {
    const t = limited();
    const threadId = await createThread(t);
    await seed(t, threadId, 4_000);
    const ids = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).map((m) => m._id),
    );
    const read = await t.query(api.messages.getMessagesByIds, {
      messageIds: ids,
    });
    expect(read).toHaveLength(4_000);
    expect(read.every((m) => m?.usage?.totalTokens === 3224)).toBe(true);
  }, 120_000);

  test("getMessagesByIds reads every other message of two threads", async () => {
    const t = limited();
    const threads = [await createThread(t), await createThread(t)];
    for (const threadId of threads) {
      await seed(t, threadId, 3_000);
    }
    const ids = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect())
        .filter((_, i) => i % 2 === 0)
        .map((m) => m._id),
    );
    const read = await t.query(api.messages.getMessagesByIds, {
      messageIds: [...ids].reverse(),
    });
    expect(read.map((m) => m?._id)).toEqual([...ids].reverse());
    expect(read.every((m) => m?.usage?.totalTokens === 3224)).toBe(true);
  }, 120_000);

  test("a read of scattered messages reads few payloads of others", async () => {
    const t = limited();
    const threadId = await createThread(t);
    await seed(t, threadId, 4_400);
    const scattered = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).filter((_, i) => i % 2 === 0),
    );
    expect(scattered).toHaveLength(2_200);
    const { readMessages } = await import("./messagePayloads.js");
    const { result, documentsRead } = await cost(t, async (ctx) =>
      readMessages(ctx, scattered, "full"),
    );
    expect(result.map((m) => m._id)).toEqual(scattered.map((m) => m._id));
    expect(result.every((m) => m.usage?.totalTokens === 3224)).toBe(true);
    expect(documentsRead).toBeLessThanOrEqual(2_200 + 400);
  }, 120_000);

  test("getMessagesByIds reads 4,000 messages as the model reads them", async () => {
    const t = limited();
    const threadId = await createThread(t);
    await seed(t, threadId, 4_000);
    const ids = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).map((m) => m._id),
    );
    const read = await t.query(api.messages.getMessagesByIds, {
      messageIds: ids,
      view: "model",
    });
    expect(read).toHaveLength(4_000);
    expect(read.every((m) => m?.text && !m.usage)).toBe(true);
  }, 120_000);

  test("a clone of more embedded messages than a transaction can join copies them all", async () => {
    const t = limited();
    const sourceThreadId = await createThread(t);
    await seed(t, sourceThreadId, 2_100, true);
    const targetThreadId = await createThread(t);
    const copied = await t.action(api.messages.cloneThread, {
      sourceThreadId,
      targetThreadId,
      batchSize: 3_000,
    });
    expect(copied).toBe(2_100);
    const { page: target } = await t.query(
      api.messages.listMessagesByThreadId,
      { threadId: targetThreadId, order: "asc", paginationOpts: page(3_000) },
    );
    expect(target).toHaveLength(2_100);
    expect(target.every((m) => m.usage?.totalTokens === 3224)).toBe(true);
    await expectConsistentStorage(t);
  }, 120_000);
});

describe("search", () => {
  test("text and vector search return what the model reads", async () => {
    const t = initConvexTest();
    const threadId = await createThread(t, "u");
    const sent = Object.values(turns).flatMap((turn) => turn());
    const vector = Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0));
    const { messages: saved } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: sent,
      embeddings: {
        model: "m",
        dimension: 128,
        vectors: sent.map((m) => (isTool(m.message) ? null : vector)),
      },
    });
    const model = new Map(
      saved.map((m) => [m._id, exact(omit(m, RESULT))] as const),
    );
    for (const args of [
      { threadId, textSearch: true },
      { threadId, vectorSearch: true, embedding: vector, embeddingModel: "m" },
      { searchAllMessagesForUserId: "u", textSearch: true },
      {
        searchAllMessagesForUserId: "u",
        vectorSearch: true,
        embedding: vector,
        embeddingModel: "m",
      },
    ]) {
      const found = await t.action(api.messages.searchMessages, {
        ...args,
        text: "needle",
        limit: 20,
      });
      expect(found.length, JSON.stringify(args)).toBeGreaterThan(3);
      for (const doc of found) {
        expect(exact(doc)).toEqual(model.get(doc._id));
      }
    }
  });
});
