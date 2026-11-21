/// <reference types="vite/client" />

import { omit } from "convex-helpers";
import type { FunctionArgs } from "convex/server";
import { convexToJson, getDocumentSize, type Value } from "convex/values";
import { describe, expect, test } from "vitest";
import { extractText, isTool } from "./shared.js";
import type { MessageDoc } from "./validators.js";
import { api } from "./component/_generated/api.js";
import type { Doc, Id } from "./component/_generated/dataModel.js";
import { initConvexTest } from "./component/setup.test.js";

type T = ReturnType<typeof initConvexTest>;
type Sent = FunctionArgs<typeof api.messages.addMessages>["messages"][number];

const metadata = {
  model: "gpt-4.1",
  provider: "openai.responses",
  providerMetadata: { openai: { responseId: "resp_1" } },
  usage: { promptTokens: 2412, completionTokens: 812, totalTokens: 3224 },
};
const answer = (text: string): Sent => ({
  message: { role: "assistant", content: [{ type: "text", text }] },
  ...metadata,
});
const words = (chars: number) => "needle ".repeat(Math.ceil(chars / 7));
const exact = (doc: object) =>
  convexToJson(omit(doc as MessageDoc, ["_id", "_creationTime"]) as Value);

async function createThread(t: T) {
  const thread = await t.mutation(api.threads.createThread, {});
  return thread._id as Id<"threads">;
}

async function save(t: T, threadId: Id<"threads">, messages: Sent[]) {
  return (await t.mutation(api.messages.addMessages, { threadId, messages }))
    .messages;
}

/** Inserts rows the way releases before text was stored once saved them. */
async function saveWhole(t: T, threadId: Id<"threads">, messages: Sent[]) {
  await t.run(async (ctx) => {
    for (const [stepOrder, message] of messages.entries()) {
      await ctx.db.insert("messages", {
        ...message,
        threadId,
        order: 0,
        stepOrder,
        status: "success",
        tool: isTool(message.message),
        text: extractText(message.message),
      } as Omit<Doc<"messages">, "_id" | "_creationTime">);
    }
  });
}

async function readAll(t: T, threadId: Id<"threads">) {
  const all = await t.query(api.messages.listMessagesByThreadId, {
    threadId,
    order: "asc",
    paginationOpts: { cursor: null, numItems: 10_000 },
  });
  const byId = await t.query(api.messages.getMessagesByIds, {
    messageIds: all.page.map((m) => m._id as Id<"messages">),
  });
  expect(byId).toEqual(all.page);
  return all.page;
}

test("a row holds its text once, and a message too short to shrink is stored whole", async () => {
  const t = initConvexTest();
  const threadId = await createThread(t);
  const long = words(1_200);
  await save(t, threadId, [answer(long), answer("ok")]);
  const [split, short] = await t.run((ctx) =>
    ctx.db.query("messages").collect(),
  );
  expect(split.text).toBe(long);
  expect(split.message!.content).toEqual([{ type: "text", text: "" }]);
  expect(short.message!.content).toEqual([{ type: "text", text: "ok" }]);
});

describe("reads return each message as saved", () => {
  test("cited text parts, including empty text a provider cites on", async () => {
    const t = initConvexTest();
    const threadId = await createThread(t);
    const citation = (citedText: string) => ({
      source: {
        type: "source" as const,
        sourceType: "url" as const,
        id: "src_1",
        url: "https://example.com",
        title: "Example",
      },
      startIndex: 0,
      endIndex: citedText.length,
      citedText,
    });
    const cited: Sent = {
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: words(1_200),
            citations: [citation("needle")],
            providerOptions: { anthropic: { cache: "a" } },
          },
          {
            type: "text",
            text: "",
            citations: [citation("")],
            providerOptions: { anthropic: { cache: "b" } },
          },
        ],
      },
      ...metadata,
    };
    await save(t, threadId, [cited]);
    const [row] = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(row.textLengths).toBeDefined();
    const [read] = await readAll(t, threadId);
    expect(exact(read.message!)).toEqual(exact(cited.message));
  });

  test("rows saved whole, before text was stored once", async () => {
    const t = initConvexTest();
    const whole = await createThread(t);
    const split = await createThread(t);
    const sent: Sent[] = [
      { message: { role: "user", content: words(1_200) } },
      answer(words(1_200)),
      answer("ok"),
      {
        message: {
          role: "assistant",
          content: [
            { type: "reasoning", text: "thinking" },
            { type: "text", text: ` lead ${words(1_200)}` },
            { type: "text", text: "" },
            { type: "tool-call", toolCallId: "c", toolName: "t", input: {} },
            { type: "text", text: "a  b " },
          ],
        },
        ...metadata,
      },
    ];
    await saveWhole(t, whole, sent);
    await save(t, split, sent);
    const strip = (docs: MessageDoc[]) =>
      docs.map((m) => exact(omit(m, ["threadId", "order", "stepOrder"])));
    expect(strip(await readAll(t, whole))).toEqual(
      strip(await readAll(t, split)),
    );
  });
});

describe("writes keep each message whole", () => {
  test("finalizing a pending message with text keeps its text", async () => {
    const t = initConvexTest();
    const partial = words(1_400);
    const threadId = await createThread(t);
    const [pending] = await save(t, threadId, [
      {
        message: { role: "assistant", content: partial },
        status: "pending",
      },
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
});

describe("near the limits", () => {
  test("a 600 KB answer fits in one row", async () => {
    const t = initConvexTest();
    const threadId = await createThread(t);
    const long = words(600_000);
    await save(t, threadId, [answer(long)]);
    const [row] = await t.run((ctx) => ctx.db.query("messages").collect());
    // Saved whole, it holds its text twice, past the 1 MiB document limit.
    expect(getDocumentSize(row)).toBeLessThan(700_000);
    expect((await readAll(t, threadId))[0].message).toEqual(
      answer(long).message,
    );
  });
});
