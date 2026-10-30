/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getConvexSize } from "convex/values";
import { convexValueSize } from "./streams.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import schema from "./schema.js";
import { initConvexTest, modules } from "./setup.test.js";

afterEach(() => vi.useRealTimers());

async function seedStream(t: ReturnType<typeof initConvexTest>) {
  const thread = await t.mutation(api.threads.createThread, {
    userId: "stream-files",
  });
  const threadId = thread._id as Id<"threads">;
  const streamId = await t.mutation(api.streams.create, {
    threadId,
    order: 0,
    stepOrder: 0,
    format: "UIMessageChunk",
  });
  const { fileId } = await t.mutation(api.files.addFile, {
    storageId: "stream-storage",
    hash: "stream-hash",
    filename: "stream.txt",
  });
  return { threadId, streamId, fileId };
}

describe("streams", () => {
  test("listDeltas rejects streams belonging to another thread", async () => {
    const t = initConvexTest();
    const { streamId } = await seedStream(t);
    const otherThread = await t.mutation(api.threads.createThread, {});
    await t.mutation(api.streams.addDelta, {
      streamId,
      start: 0,
      end: 1,
      parts: ["private delta"],
    });

    await expect(
      t.query(api.streams.listDeltas, {
        threadId: otherThread._id as Id<"threads">,
        cursors: [{ streamId, cursor: 0 }],
      }),
    ).rejects.toThrow("Stream does not belong to the given thread");
  });

  test("listDeltas skips deleted streams even if deltas remain", async () => {
    const t = initConvexTest();
    const { threadId, streamId } = await seedStream(t);
    await t.mutation(api.streams.addDelta, {
      streamId,
      start: 0,
      end: 1,
      parts: ["orphaned delta"],
    });
    await t.run((ctx) => ctx.db.delete("streamingMessages", streamId));

    await expect(
      t.query(api.streams.listDeltas, {
        threadId,
        cursors: [{ streamId, cursor: 0 }],
      }),
    ).resolves.toEqual([]);
  });

  test("stream file ownership flows from addDelta to the final message", async () => {
    const t = initConvexTest();
    const { threadId, streamId, fileId } = await seedStream(t);
    const url = "https://files.example/stream";

    await t.mutation(api.streams.addDelta, {
      streamId,
      start: 0,
      end: 1,
      parts: [{ type: "start" }],
      fileRefs: [{ url, fileId }],
    });
    await expect(t.query(api.files.get, { fileId })).resolves.toMatchObject({
      refcount: 1,
    });

    // Repeating the same URL/file pair keeps a single reference.
    await t.mutation(api.streams.addDelta, {
      streamId,
      start: 1,
      end: 2,
      parts: [{ type: "text-delta", id: "text-1", delta: "hi" }],
      fileRefs: [{ url, fileId }],
    });
    await expect(t.query(api.files.get, { fileId })).resolves.toMatchObject({
      refcount: 1,
    });

    // A durable file can be referenced by more than one persisted URL.
    await t.mutation(api.streams.addDelta, {
      streamId,
      start: 2,
      end: 3,
      parts: [{ type: "text-delta", id: "text-1", delta: "there" }],
      fileRefs: [{ url: `${url}-alternate`, fileId }],
    });
    await expect(t.query(api.files.get, { fileId })).resolves.toMatchObject({
      refcount: 1,
    });

    const { fileId: otherFileId } = await t.mutation(api.files.addFile, {
      storageId: "other-storage",
      hash: "other-hash",
      filename: "other.txt",
    });
    await expect(
      t.mutation(api.streams.addDelta, {
        streamId,
        start: 3,
        end: 4,
        parts: [{ type: "finish" }],
        fileRefs: [{ url, fileId: otherFileId }],
      }),
    ).rejects.toThrow("Stream file URL maps to multiple files");
    await expect(
      t.query(api.files.get, { fileId: otherFileId }),
    ).resolves.toMatchObject({ refcount: 0 });
    expect(
      (await t.run((ctx) => ctx.db.get("streamingMessages", streamId)))
        ?.fileRefs,
    ).toEqual([
      { url, fileId },
      { url: `${url}-alternate`, fileId },
    ]);

    await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [
        {
          message: { role: "assistant", content: "done" },
          fileIds: [fileId],
        },
      ],
      finishStreamId: streamId,
    });
    await expect(t.query(api.files.get, { fileId })).resolves.toMatchObject({
      refcount: 1,
    });
    const stream = await t.run((ctx) =>
      ctx.db.get("streamingMessages", streamId),
    );
    expect(stream?.state.kind).toBe("finished");
    expect(stream?.fileRefs).toBeUndefined();
  });

  test("bulk deletion preserves global stream order across status lanes", async () => {
    vi.useFakeTimers();

    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {
      userId: "stream-cleanup",
    });
    const threadId = thread._id as Id<"threads">;
    const earlyStreamId = await t.run(async (ctx) => {
      const streamId = await ctx.db.insert("streamingMessages", {
        threadId,
        order: 1,
        stepOrder: 0,
        format: "UIMessageChunk",
        state: { kind: "streaming", lastHeartbeat: Date.now() },
      });
      await ctx.db.insert("streamingMessages", {
        threadId,
        order: 9,
        stepOrder: 0,
        format: "UIMessageChunk",
        state: { kind: "aborted", reason: "retained regeneration" },
      });
      await ctx.db.insert("streamDeltas", {
        streamId,
        start: 0,
        end: 1,
        parts: [{ type: "text-start", id: "text" }],
      });
      return streamId;
    });

    await t.mutation(api.streams.deleteAllStreamsForThreadIdAsync, {
      threadId,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(
      await t.query(api.streams.list, {
        threadId,
        statuses: ["streaming", "finished", "aborted"],
      }),
    ).toEqual([]);
    expect(
      await t.query(api.streams.listDeltas, {
        threadId,
        cursors: [{ streamId: earlyStreamId, cursor: 0 }],
      }),
    ).toEqual([]);
  });

  test.each([
    ["numbers", { parts: [{ type: "data", data: Array(1000).fill(0) }] }],
    [
      "text",
      { parts: [{ type: "text-delta", id: "t", delta: "x".repeat(1000) }] },
    ],
    [
      "unicode",
      { parts: [{ type: "text-delta", id: "t", delta: "🦉".repeat(250) }] },
    ],
    [
      "nested",
      {
        parts: [{ type: "data", data: { a: [1, "b", null, true, { c: [] }] } }],
      },
    ],
    ["bytes", { parts: [{ type: "file", data: new ArrayBuffer(777) }] }],
  ])("delta sizing matches Convex accounting for %s", (_name, doc) => {
    expect(convexValueSize(doc)).toBe(getConvexSize(doc));
  });

  test("sync deletion refuses a stream it cannot delete in one transaction", async () => {
    const t = convexTest({
      schema,
      modules,
      transactionLimits: true,
    });
    const thread = await t.mutation(api.threads.createThread, {
      userId: "bounded-stream-cleanup",
    });
    const threadId = thread._id as Id<"threads">;
    const streamId = await t.mutation(api.streams.create, {
      threadId,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk",
    });
    for (let i = 0; i < 28; i++) {
      await t.mutation(api.streams.addDelta, {
        streamId,
        start: i,
        end: i + 1,
        parts: [
          { type: "text-delta", id: "large-delta", delta: "x".repeat(600_000) },
        ],
      });
    }

    await expect(
      t.mutation(api.streams.deleteStreamSync, { streamId }),
    ).rejects.toThrow(/deleteStreamAsync/);

    expect(
      await t.query(api.streams.list, {
        threadId,
        statuses: ["streaming", "finished", "aborted"],
      }),
    ).toHaveLength(1);
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("streamDeltas")
          .withIndex("streamId_start_end", (q) => q.eq("streamId", streamId))
          .first(),
      ),
    ).not.toBeNull();
  });

  test("async deletion stays within transaction read limits", async () => {
    vi.useFakeTimers();

    const t = convexTest({
      schema,
      modules,
      transactionLimits: true,
    });
    const thread = await t.mutation(api.threads.createThread, {
      userId: "bounded-stream-cleanup",
    });
    const threadId = thread._id as Id<"threads">;
    const streamId = await t.mutation(api.streams.create, {
      threadId,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk",
    });
    for (let i = 0; i < 28; i++) {
      await t.mutation(api.streams.addDelta, {
        streamId,
        start: i,
        end: i + 1,
        parts: [
          {
            type: "text-delta",
            id: "large-delta",
            delta: "x".repeat(600_000),
          },
        ],
      });
    }

    await t.mutation(api.streams.deleteStreamAsync, { streamId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(
      await t.query(api.streams.list, {
        threadId,
        statuses: ["streaming", "finished", "aborted"],
      }),
    ).toEqual([]);
    expect(
      await t.query(api.streams.listDeltas, {
        threadId,
        cursors: [{ streamId, cursor: 0 }],
      }),
    ).toEqual([]);
  });

  test("pages large deltas across streams without gaps", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const thread = await t.mutation(api.threads.createThread, {
      userId: "large-deltas",
    });
    const threadId = thread._id as Id<"threads">;
    const cursors = new Map<Id<"streamingMessages">, number>();
    for (let s = 0; s < 2; s++) {
      const streamId = await t.mutation(api.streams.create, {
        threadId,
        order: 0,
        stepOrder: s,
        format: "UIMessageChunk",
      });
      cursors.set(streamId, 0);
      for (let i = 0; i < 15; i++) {
        await t.mutation(api.streams.addDelta, {
          streamId,
          start: i,
          end: i + 1,
          parts: [{ type: "text-delta", id: "t", delta: "x".repeat(600_000) }],
        });
      }
    }

    for (;;) {
      const page = await t.query(api.streams.listDeltas, {
        threadId,
        cursors: [...cursors].map(([streamId, cursor]) => ({
          streamId,
          cursor,
        })),
      });
      if (page.length === 0) break;
      for (const delta of page) {
        const streamId = delta.streamId as Id<"streamingMessages">;
        expect(delta.start).toBe(cursors.get(streamId));
        cursors.set(streamId, delta.end);
      }
    }
    expect([...cursors.values()]).toEqual([15, 15]);
  });
});

// A generation links its stream to the pending message it writes to, and step
// saves move the link along, so a timeout fails only that message (#168).
describe("a stream that times out", () => {
  const MINUTE = 60 * 1000;

  async function promptedThread(t: ReturnType<typeof initConvexTest>) {
    vi.useFakeTimers();
    const thread = await t.mutation(api.threads.createThread, {
      userId: "stream-timeout",
    });
    const threadId = thread._id as Id<"threads">;
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [{ message: { role: "user", content: "hello" } }],
    });
    const promptMessageId = messages[0]!._id as Id<"messages">;
    const generate = async (
      text: string | undefined,
      { restart = false }: { restart?: boolean } = {},
    ) => {
      const { messages } = await t.mutation(api.messages.addMessages, {
        threadId,
        promptMessageId,
        failPendingSteps: restart,
        messages: [
          { message: { role: "assistant", content: [] }, status: "pending" },
        ],
      });
      const pending = messages[0]!;
      const messageId = pending._id as Id<"messages">;
      const streamId = await t.mutation(api.streams.create, {
        threadId,
        order: pending.order,
        stepOrder: pending.stepOrder,
        format: "UIMessageChunk",
        pendingMessageId: messageId,
      });
      if (text !== undefined) {
        await t.mutation(api.streams.addDelta, {
          streamId,
          start: 0,
          end: 3,
          parts: [
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: text },
            { type: "text-end", id: "text" },
          ],
        });
      }
      return { messageId, streamId };
    };
    // Also runs whatever those functions schedule to run right away.
    const advance = async (ms: number) => {
      for (const step of [ms, 1, 1]) {
        vi.advanceTimersByTime(step);
        await t.finishInProgressScheduledFunctions();
      }
    };
    const message = (messageId: Id<"messages">) =>
      t.run((ctx) => ctx.db.get("messages", messageId));
    const streamState = async (streamId: Id<"streamingMessages">) =>
      (await t.run((ctx) => ctx.db.get("streamingMessages", streamId)))?.state
        .kind;
    return { threadId, generate, advance, message, streamState };
  }

  test("fails its pending message and keeps the streamed text", async () => {
    const t = initConvexTest();
    const { generate, advance, message } = await promptedThread(t);
    const { messageId } = await generate("streamed before the action died");

    await advance(10 * MINUTE);

    expect(await message(messageId)).toMatchObject({
      status: "failed",
      text: "streamed before the action died",
      error: "Stream timed out",
    });
  });

  test("fails a pending message that has no deltas", async () => {
    const t = initConvexTest();
    const { generate, advance, message } = await promptedThread(t);
    const { messageId } = await generate(undefined);

    await advance(10 * MINUTE);

    expect(await message(messageId)).toMatchObject({
      status: "failed",
      error: "Stream timed out",
    });
  });

  test("leaves a message that already ended as it was", async () => {
    const t = initConvexTest();
    const { threadId, generate, advance, message } = await promptedThread(t);
    const failed = await generate("streamed before the client failed");
    await t.mutation(api.messages.finalizeMessage, {
      messageId: failed.messageId,
      result: { status: "failed", error: "socket hang up" },
    });
    const saved = await generate("streamed");
    await t.mutation(api.messages.addMessages, {
      threadId,
      pendingMessageId: saved.messageId,
      streamId: saved.streamId,
      failPendingSteps: false,
      messages: [{ message: { role: "assistant", content: "saved" } }],
    });

    await advance(10 * MINUTE);

    expect(await message(failed.messageId)).toMatchObject({
      status: "failed",
      text: "streamed before the client failed",
      error: "socket hang up",
    });
    expect(await message(saved.messageId)).toMatchObject({
      status: "success",
      text: "saved",
    });
  });

  test.each([
    { restart: false, olderError: "Stream timed out" },
    { restart: true, olderError: "Restarting" },
  ])(
    "leaves a newer generation at the same order alone (restart: $restart)",
    async ({ restart, olderError }) => {
      const t = initConvexTest();
      const { generate, advance, message, streamState } =
        await promptedThread(t);
      const older = await generate("abandoned");
      await advance(5 * MINUTE);
      const newer = await generate("still streaming", { restart });

      await advance(5 * MINUTE);

      expect(await streamState(older.streamId)).toBe("aborted");
      expect(await message(older.messageId)).toMatchObject({
        status: "failed",
        error: olderError,
      });
      expect(await streamState(newer.streamId)).toBe("streaming");
      expect(await message(newer.messageId)).toMatchObject({
        status: "pending",
      });
      expect((await message(newer.messageId))?.text).toBeUndefined();
    },
  );

  test("follows the generation's pending message to the next step", async () => {
    const t = initConvexTest();
    const { threadId, generate, advance, message } = await promptedThread(t);
    const { messageId, streamId } = await generate("step two");
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      pendingMessageId: messageId,
      streamId,
      failPendingSteps: false,
      messages: [
        { message: { role: "assistant", content: "step one" } },
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
    });
    const next = messages.at(-1)!._id as Id<"messages">;

    await advance(10 * MINUTE);

    expect(await message(messageId)).toMatchObject({
      status: "success",
      text: "step one",
    });
    expect(await message(next)).toMatchObject({
      status: "failed",
      error: "Stream timed out",
    });
  });

  test("recovers only its own stream, not a replaced generation's", async () => {
    const t = initConvexTest();
    const { generate, advance, message } = await promptedThread(t);
    const older = await generate(undefined);
    // The older generation streamed a whole tool step and its answer, then
    // died before saving any of it.
    await t.mutation(api.streams.addDelta, {
      streamId: older.streamId,
      start: 0,
      end: 9,
      parts: [
        { type: "start-step" },
        {
          type: "tool-input-available",
          toolCallId: "call-1",
          toolName: "lookup",
          input: {},
        },
        {
          type: "tool-output-available",
          toolCallId: "call-1",
          output: { type: "text", value: "found" },
        },
        { type: "finish-step" },
        { type: "start-step" },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "older text" },
        { type: "text-end", id: "text" },
        { type: "finish-step" },
      ],
    });
    const newer = await generate("newer text", { restart: true });

    await advance(15 * MINUTE);

    expect(await message(older.messageId)).toMatchObject({
      status: "failed",
      error: "Restarting",
    });
    expect(await message(newer.messageId)).toMatchObject({
      status: "failed",
      text: "newer text",
      error: "Stream timed out",
    });
    expect(
      (await t.run((ctx) => ctx.db.query("messages").collect())).map(
        (m) => m.text,
      ),
    ).not.toContain("older text");
  });

  test("commits the timeout within transaction limits", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const { generate, advance, message, streamState } = await promptedThread(t);
    const older = await generate("x".repeat(700_000));
    for (let i = 3; i < 10; i++) {
      await t.mutation(api.streams.addDelta, {
        streamId: older.streamId,
        start: i,
        end: i + 1,
        parts: [{ type: "text-delta", id: "text", delta: "x".repeat(700_000) }],
      });
    }
    await advance(5 * MINUTE);
    const newer = [];
    for (let i = 0; i < 3; i++) {
      newer.push(await generate("x".repeat(700_000)));
    }

    await advance(5 * MINUTE);

    expect(await streamState(older.streamId)).toBe("aborted");
    expect(await message(older.messageId)).toMatchObject({ status: "failed" });
    for (const { messageId } of newer) {
      expect(await message(messageId)).toMatchObject({ status: "pending" });
    }
  });

  test("aborts a stream with no pending message", async () => {
    const t = initConvexTest();
    const { threadId, advance, streamState } = await promptedThread(t);
    const streamId = await t.mutation(api.streams.create, {
      threadId,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk",
    });

    await advance(10 * MINUTE);

    expect(await streamState(streamId)).toBe("aborted");
  });
});

describe("claiming a pending message", () => {
  test("a lapsed claim's recovered text doesn't hide the claim that replaced it", async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [
        { message: { role: "user", content: "hello" } },
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
    });
    const placeholder = messages[1]!;
    const messageId = placeholder._id as Id<"messages">;
    const claim = () =>
      t.mutation(api.messages.claimPendingMessage, { threadId, messageId });
    expect(await claim()).toMatchObject({ status: "claimed" });
    // The first attempt streams a tool step and an answer, then dies.
    const streamId = await t.mutation(api.streams.create, {
      threadId,
      order: placeholder.order,
      stepOrder: placeholder.stepOrder,
      format: "UIMessageChunk",
      pendingMessageId: messageId,
    });
    await t.mutation(api.streams.addDelta, {
      streamId,
      start: 0,
      end: 9,
      parts: [
        { type: "start-step" },
        {
          type: "tool-input-available",
          toolCallId: "call-1",
          toolName: "lookup",
          input: {},
        },
        {
          type: "tool-output-available",
          toolCallId: "call-1",
          output: { type: "text", value: "found" },
        },
        { type: "finish-step" },
        { type: "start-step" },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "first attempt" },
        { type: "text-end", id: "text" },
        { type: "finish-step" },
      ],
    });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(await claim()).toMatchObject({ status: "claimed" });

    // The first attempt's text is recovered after the second claim.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1);
      await t.finishInProgressScheduledFunctions();
    }
    expect(
      (await t.run((ctx) => ctx.db.query("messages").collect())).at(-1)?.text,
    ).toBe("first attempt");

    expect(await claim()).toMatchObject({ status: "running" });
  });

  test("refuses a message from another thread, and leaves it alone", async () => {
    const t = initConvexTest();
    const seed = async () => {
      const thread = await t.mutation(api.threads.createThread, {});
      const threadId = thread._id as Id<"threads">;
      const { messages } = await t.mutation(api.messages.addMessages, {
        threadId,
        messages: [
          { message: { role: "user", content: "hello" } },
          { message: { role: "assistant", content: [] }, status: "pending" },
        ],
      });
      return { threadId, messageId: messages[1]!._id as Id<"messages"> };
    };
    const mine = await seed();
    const theirs = await seed();

    await expect(
      t.mutation(api.messages.claimPendingMessage, {
        threadId: mine.threadId,
        messageId: theirs.messageId,
      }),
    ).rejects.toThrow();

    const { page } = await t.query(api.messages.listMessagesByThreadId, {
      threadId: mine.threadId,
      order: "asc",
    });
    await expect(
      t.mutation(api.messages.claimPendingMessage, {
        threadId: mine.threadId,
        messageId: page[0]!._id as Id<"messages">,
      }),
    ).rejects.toThrow();
    expect(
      await t.mutation(api.messages.claimPendingMessage, theirs),
    ).toMatchObject({ status: "claimed" });
  });
});
