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

  test("thread stream deletion continues within a transaction while it fits", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    const streamIds: Id<"streamingMessages">[] = [];
    for (let order = 0; order < 5; order++) {
      const streamId = await t.mutation(api.streams.create, {
        threadId,
        order,
        stepOrder: 0,
        format: "UIMessageChunk",
      });
      await insertDeltas(t, streamId, 0, 1000, 10);
      streamIds.push(streamId);
    }

    await t.mutation(api.streams.deleteAllStreamsForThreadIdAsync, {
      threadId,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    for (const streamId of streamIds) {
      expect(await countDeltas(t, streamId)).toBe(0);
    }
    expect(
      await t.query(api.streams.list, {
        threadId,
        statuses: ["streaming", "finished", "aborted"],
      }),
    ).toEqual([]);
    expect(await t.query(api.threads.getThread, { threadId })).toBeNull();
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
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await countDeltas(t, streamId)).toBe(0);
    expect(
      await t.run((ctx) => ctx.db.get("streamingMessages", streamId)),
    ).toBeNull();
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
