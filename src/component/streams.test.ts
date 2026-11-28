/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getConvexSize } from "convex/values";
import { defineSchema, defineTable } from "convex/server";
import { omit } from "convex-helpers";
import { convexValueSize } from "./streams.js";
import { api, internal } from "./_generated/api.js";
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

async function insertDeltas(
  t: ReturnType<typeof initConvexTest>,
  streamId: Id<"streamingMessages">,
  start: number,
  count: number,
  size: number,
) {
  await t.run(async (ctx) => {
    for (let i = start; i < start + count; i++) {
      await ctx.db.insert("streamDeltas", {
        streamId,
        start: i,
        end: i + 1,
        parts: [{ type: "text-delta", id: "t", delta: "x".repeat(size) }],
      });
    }
  });
}

async function countDeltas(
  t: ReturnType<typeof initConvexTest>,
  streamId: Id<"streamingMessages">,
) {
  return t.run(
    async (ctx) =>
      (
        await ctx.db
          .query("streamDeltas")
          .withIndex("streamId_start_end", (q) => q.eq("streamId", streamId))
          .collect()
      ).length,
  );
}

async function scheduledRuns(t: ReturnType<typeof initConvexTest>) {
  return t.run(
    async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (fn) => fn.name.includes("delete"),
      ).length,
  );
}

describe("streams", () => {
  test("listDeltas reads a stream of another thread as missing", async () => {
    const t = initConvexTest();
    const { streamId } = await seedStream(t);
    const otherThread = await t.mutation(api.threads.createThread, {});
    await t.mutation(api.streams.addDelta, {
      streamId,
      start: 0,
      end: 1,
      parts: ["private delta"],
    });

    expect(
      await t.query(api.streams.listDeltas, {
        threadId: otherThread._id as Id<"threads">,
        cursors: [{ streamId, cursor: 0 }],
      }),
    ).toEqual([]);
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
    ["a stream", 1],
    ["no streams", 0],
  ])(
    "deleting a thread's streams keeps the thread and its messages with %s",
    async (_, streamCount) => {
      vi.useFakeTimers();

      const t = initConvexTest();
      const thread = await t.mutation(api.threads.createThread, {
        userId: "stream-delete",
      });
      const threadId = thread._id as Id<"threads">;
      await t.mutation(api.messages.addMessages, {
        threadId,
        messages: [{ message: { role: "user", content: "keep me" } }],
      });
      // Inserted directly so no stream timeout is scheduled: the only
      // scheduled work is the bulk delete's own continuation.
      await t.run(async (ctx) => {
        for (let i = 0; i < streamCount; i++) {
          const streamId = await ctx.db.insert("streamingMessages", {
            threadId,
            order: i,
            stepOrder: 0,
            format: "UIMessageChunk",
            state: { kind: "streaming", lastHeartbeat: Date.now() },
          });
          await ctx.db.insert("streamDeltas", {
            streamId,
            start: 0,
            end: 1,
            parts: [{ type: "text-start", id: "text" }],
          });
        }
      });

      await t.mutation(api.streams.deleteAllStreamsForThreadIdAsync, {
        threadId,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(await t.query(api.threads.getThread, { threadId })).not.toBeNull();
      const messages = await t.query(api.messages.listMessagesByThreadId, {
        threadId,
        order: "asc",
        paginationOpts: { cursor: null, numItems: 10 },
      });
      expect(messages.page).toHaveLength(1);
      expect(
        await t.run(async (ctx) => ({
          streams: (await ctx.db.query("streamingMessages").collect()).length,
          deltas: (await ctx.db.query("streamDeltas").collect()).length,
        })),
      ).toEqual({ streams: 0, deltas: 0 });
    },
  );

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

  test("sync deletion finishes a stream that fits in one transaction", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    const streamId = await t.mutation(api.streams.create, {
      threadId,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk",
    });
    for (let i = 0; i < 18; i++) {
      await t.mutation(api.streams.addDelta, {
        streamId,
        start: i,
        end: i + 1,
        parts: [{ type: "text-delta", id: "t", delta: "x".repeat(300_000) }],
      });
    }

    await t.mutation(api.streams.deleteStreamSync, { streamId });

    expect(await countDeltas(t, streamId)).toBe(0);
    expect(
      await t.run((ctx) => ctx.db.get("streamingMessages", streamId)),
    ).toBeNull();
  });

  test("async deletion continues within a transaction while it fits", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    const streamId = await t.mutation(api.streams.create, {
      threadId,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk",
    });
    await insertDeltas(t, streamId, 0, 5000, 10);

    await t.mutation(api.streams.deleteStreamAsync, { streamId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await countDeltas(t, streamId)).toBe(0);
    expect(
      await t.run((ctx) => ctx.db.get("streamingMessages", streamId)),
    ).toBeNull();
    expect(await scheduledRuns(t)).toBe(1);
  });

  test("async deletion leaves a page that does not fit to the next transaction", async () => {
    vi.useFakeTimers();
    const t = convexTest({
      schema,
      modules,
      transactionLimits: { bytesRead: 3 * 1024 * 1024 },
    });
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    const streamId = await t.mutation(api.streams.create, {
      threadId,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk",
    });
    await insertDeltas(t, streamId, 0, 2000, 10);
    await insertDeltas(t, streamId, 2000, 4, 600_000);

    await t.mutation(api.streams.deleteStreamAsync, { streamId });
    const remainingAfterEachHop: number[] = [];
    while (
      remainingAfterEachHop.length < 10 &&
      (await t.run((ctx) => ctx.db.get("streamingMessages", streamId)))
    ) {
      vi.advanceTimersToNextTimer();
      await t.finishInProgressScheduledFunctions();
      remainingAfterEachHop.push(await countDeltas(t, streamId));
    }

    expect(remainingAfterEachHop).toEqual([4, 2, 0, 0]);
    expect(
      await t.run((ctx) => ctx.db.get("streamingMessages", streamId)),
    ).toBeNull();
  });

  test("async deletion surfaces a failed step instead of rescheduling it", async () => {
    const t = initConvexTest();
    const { streamId, fileId } = await seedStream(t);
    await t.mutation(api.streams.addDelta, {
      streamId,
      start: 0,
      end: 1,
      parts: ["delta"],
      fileRefs: [{ url: "https://files.example/stream", fileId }],
    });
    await insertDeltas(t, streamId, 1, 1500, 10);
    await t.run((ctx) => ctx.db.patch("files", fileId, { refcount: 0 }));

    await expect(
      t.mutation(internal.streams._deleteStreamAsync, { streamId }),
    ).rejects.toThrow("refcount underflow");
    expect(await countDeltas(t, streamId)).toBe(1501);
    expect(await scheduledRuns(t)).toBe(0);
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

describe("plain streams with their pending message", () => {
  test("addMessages createStream starts the pending message's stream, which a plain fill leaves streaming", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    const saved = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [
        { message: { role: "user", content: "Hi." } },
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
      createStream: { format: "UIMessageChunk" },
    });
    const pending = saved.messages[1];
    const [stream] = await t.query(api.streams.list, { threadId });
    await t.mutation(api.messages.addMessages, {
      threadId,
      pendingMessageId: pending._id as Id<"messages">,
      messages: [{ message: { role: "assistant", content: "Hello." } }],
    });
    expect({
      stream: [
        stream.streamId === saved.streamId,
        stream.order,
        stream.stepOrder,
      ],
      after: (await t.query(api.streams.list, { threadId })).map(
        (s) => s.status,
      ),
    }).toEqual({
      stream: [true, pending.order, pending.stepOrder],
      after: ["streaming"],
    });
  });

  test("streams.fail ends the stream as aborted with its reason, after its final delta", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    const streamId = await t.mutation(api.streams.create, {
      threadId,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk",
    });
    const failed = await t.mutation(api.streams.fail, {
      streamId,
      reason: "Broke.",
      finalDelta: {
        streamId,
        start: 0,
        end: 1,
        parts: [{ type: "text-delta", id: "a", delta: "Half." }],
      },
    });
    const [stream] = await t.query(api.streams.list, {
      threadId,
      statuses: ["aborted"],
    });
    const deltas = await t.query(api.streams.listDeltas, {
      threadId,
      cursors: [{ streamId, cursor: 0 }],
    });
    const state = await t.run(
      async (ctx) => (await ctx.db.get("streamingMessages", streamId))?.state,
    );
    expect({
      failed,
      status: stream.status,
      reason: state?.kind === "aborted" && state.reason,
      deltas: deltas.length,
    }).toEqual({
      failed: true,
      status: "aborted",
      reason: "Broke.",
      deltas: 1,
    });
  });

  test("a stream is only created with a new pending message last, else nothing is written", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [
        { message: { role: "user", content: "hi" } },
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
    });
    const rows = () =>
      t.run(async (ctx) => ({
        messages: await ctx.db.query("messages").collect(),
        streams: await ctx.db.query("streamingMessages").collect(),
      }));
    const before = await rows();
    for (const args of [
      { messages: [{ message: { role: "user" as const, content: "again" } }] },
      {
        pendingMessageId: messages[1]._id as Id<"messages">,
        messages: [
          {
            message: { role: "assistant" as const, content: [] },
            status: "pending" as const,
          },
        ],
      },
    ]) {
      await expect(
        t.mutation(api.messages.addMessages, {
          threadId,
          createStream: { format: "UIMessageChunk" },
          ...args,
        }),
      ).rejects.toThrow("createStream needs a new pending message last");
    }
    expect(await rows()).toEqual(before);
  });

  test("the app failing a plain streaming reply aborts its stream", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    const reply = (text: string) =>
      t.mutation(api.messages.addMessages, {
        threadId,
        messages: [
          { message: { role: "user", content: text } },
          { message: { role: "assistant", content: [] }, status: "pending" },
        ],
        createStream: { format: "UIMessageChunk" },
      });
    const updated = await reply("Go.");
    await t.mutation(api.messages.updateMessage, {
      messageId: updated.messages[1]._id as Id<"messages">,
      patch: { status: "failed", error: "Failed by the app." },
    });
    const finalized = await reply("Again.");
    await t.mutation(api.messages.finalizeMessage, {
      messageId: finalized.messages[1]._id as Id<"messages">,
      result: { status: "failed", error: "Stopped" },
    });
    const streams = await t.query(api.streams.list, {
      threadId,
      statuses: ["streaming", "aborted"],
    });
    expect(streams.map((s) => s.status)).toEqual(["aborted", "aborted"]);
  });

  test("finalizing a plain streaming reply whose recovery fails aborts its stream", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    const saved = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [
        { message: { role: "user", content: "Go." } },
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
      createStream: { format: "UIMessageChunk" },
    });
    const reply = saved.messages[1];
    // More streams at its position than recovery reads, so recovery fails.
    for (let i = 0; i < 10; i++) {
      await t.mutation(api.streams.create, {
        threadId,
        order: reply.order,
        stepOrder: reply.stepOrder,
        format: "UIMessageChunk",
      });
    }
    await t.mutation(api.messages.finalizeMessage, {
      messageId: reply._id as Id<"messages">,
      result: { status: "success" },
    });
    const [after] = await t.query(api.messages.getMessagesByIds, {
      messageIds: [reply._id as Id<"messages">],
    });
    const linked = (
      await t.query(api.streams.list, {
        threadId,
        statuses: ["streaming", "aborted"],
      })
    ).find((s) => s.streamId === saved.streamId);
    expect([after?.status, linked?.status]).toEqual(["failed", "aborted"]);
  });

  test("a plain retry aborts the replaced attempt's stream, and its row keeps what it streamed (#432)", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [{ message: { role: "user", content: "Go." } }],
    });
    const promptMessageId = messages[0]._id as Id<"messages">;
    const attempt = (failPendingSteps: boolean) =>
      t.mutation(api.messages.addMessages, {
        threadId,
        promptMessageId,
        failPendingSteps,
        messages: [
          { message: { role: "assistant", content: [] }, status: "pending" },
        ],
        createStream: { format: "UIMessageChunk" },
      });
    const first = await attempt(false);
    await t.mutation(api.streams.addDelta, {
      streamId: first.streamId!,
      start: 0,
      end: 1,
      parts: [
        { type: "start-step" },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Half." },
      ],
    });
    const retry = await attempt(true);
    const rows = await t.query(api.messages.listMessagesByThreadId, {
      threadId,
      order: "asc",
      statuses: ["pending", "failed"],
    });
    const streams = await t.query(api.streams.list, {
      threadId,
      statuses: ["streaming", "aborted"],
    });
    expect({
      rows: rows.page.map((m) => [m.status, m.error, m.text]),
      streams: Object.fromEntries(
        streams.map((s) => [
          s.streamId === retry.streamId ? "retry" : "replaced",
          s.status,
        ]),
      ),
    }).toEqual({
      rows: [
        ["failed", "Restarting", "Half."],
        ["pending", undefined, undefined],
      ],
      streams: { replaced: "aborted", retry: "streaming" },
    });
  });

  test("a settled plain reply has only fields older component versions accept", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    const reply = () =>
      t.mutation(api.messages.addMessages, {
        threadId,
        messages: [
          { message: { role: "user", content: "Go." } },
          { message: { role: "assistant", content: [] }, status: "pending" },
        ],
        createStream: { format: "UIMessageChunk" },
      });
    const filled = await reply();
    await t.mutation(api.messages.addMessages, {
      threadId,
      pendingMessageId: filled.messages[1]._id as Id<"messages">,
      messages: [{ message: { role: "assistant", content: "Done." } }],
      finishStreamId: filled.streamId,
    });
    const failed = await reply();
    await t.mutation(api.messages.finalizeMessage, {
      messageId: failed.messages[1]._id as Id<"messages">,
      result: { status: "failed", error: "Broke." },
    });
    const older = convexTest(
      defineSchema({
        ...schema.tables,
        messages: defineTable(
          omit(schema.tables.messages.validator.fields, ["streamId"]),
        ),
      }),
      modules,
    );
    const docs = await t.run((ctx) => ctx.db.query("messages").collect());
    for (const { _id, _creationTime, ...doc } of docs) {
      await older.run((ctx) => ctx.db.insert("messages", doc));
    }
  });

  test("a retry replacing several streamed attempts stays within one transaction's reads", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [{ message: { role: "user", content: "go" } }],
    });
    const promptMessageId = messages[0]._id as Id<"messages">;
    const attempt = () =>
      t.mutation(api.messages.addMessages, {
        threadId,
        promptMessageId,
        messages: [
          { message: { role: "assistant", content: [] }, status: "pending" },
        ],
        createStream: { format: "UIMessageChunk" },
      });
    for (let i = 0; i < 3; i++) {
      const streamId = (await attempt()).streamId as Id<"streamingMessages">;
      for (let step = 0; step < 10; step++) {
        const id = `t${step}`;
        await t.run((ctx) =>
          ctx.db.insert("streamDeltas", {
            streamId,
            start: step,
            end: step + 1,
            parts: [
              { type: "start-step" },
              { type: "text-start", id },
              { type: "text-delta", id, delta: "x".repeat(500_000) },
              { type: "text-end", id },
              { type: "finish-step" },
            ],
          }),
        );
      }
    }
    await t.mutation(api.messages.addMessages, {
      threadId,
      promptMessageId,
      failPendingSteps: true,
      messages: [
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
      createStream: { format: "UIMessageChunk" },
    });
    const assistants = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect())
        .filter((m) => m.message?.role === "assistant")
        .map((m) => m.status),
    );
    expect(assistants.filter((status) => status !== "failed")).toEqual([
      "pending",
    ]);
  });
});
