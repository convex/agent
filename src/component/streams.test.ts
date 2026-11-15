/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getConvexSize, getDocumentSize } from "convex/values";
import {
  convexValueSize,
  getStreamingMessagesWithMetadata,
  MAX_MATERIALIZATION_BYTES,
  MAX_MATERIALIZATION_ROWS,
} from "./streams.js";
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

describe("getStreamingMessagesWithMetadata", () => {
  type Seed = { stepOrder?: number; deltas: string[] };

  async function seed(streams: Seed[]) {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const thread = await t.mutation(api.threads.createThread, {
      userId: "materialize",
    });
    const threadId = thread._id as Id<"threads">;
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
    });
    const pending = messages[0]!;
    const streamIds: Id<"streamingMessages">[] = [];
    for (const { stepOrder = pending.stepOrder, deltas } of streams) {
      const streamId = await t.run((ctx) =>
        ctx.db.insert("streamingMessages", {
          threadId,
          order: pending.order,
          stepOrder,
          format: "UIMessageChunk",
          state: { kind: "aborted", reason: "interrupted" },
        }),
      );
      streamIds.push(streamId);
      const rows = [
        [{ type: "text-start" as const, id: "text" }],
        ...deltas.map((delta) => [
          { type: "text-delta" as const, id: "text", delta },
        ]),
      ];
      for (let i = 0; i < rows.length; i += 4000) {
        await t.run(async (ctx) => {
          for (const [j, parts] of rows.slice(i, i + 4000).entries()) {
            await ctx.db.insert("streamDeltas", {
              streamId,
              start: i + j,
              end: i + j + 1,
              parts,
            });
          }
        });
      }
    }
    return { t, threadId, pending, streamIds };
  }
  type Seeded = Awaited<ReturnType<typeof seed>>;

  const deltasOf = (s: Seeded, streamId: Id<"streamingMessages">) =>
    s.t.run((ctx) =>
      ctx.db
        .query("streamDeltas")
        .withIndex("streamId_start_end", (q) => q.eq("streamId", streamId))
        .collect(),
    );

  // Grows the stream's last delta so its documents total exactly `bytes`.
  async function padTo(
    s: Seeded,
    streamId: Id<"streamingMessages">,
    bytes: number,
  ) {
    const deltas = await deltasOf(s, streamId);
    const total = deltas.reduce((n, d) => n + getDocumentSize(d), 0);
    const last = deltas.at(-1)!;
    const part = last.parts[0] as { delta: string };
    await s.t.run((ctx) =>
      ctx.db.patch("streamDeltas", last._id, {
        parts: [
          { ...part, delta: part.delta + "x".repeat(bytes - total) },
        ] as typeof last.parts,
      }),
    );
    const padded = await deltasOf(s, streamId);
    expect(padded.reduce((n, d) => n + getDocumentSize(d), 0)).toBe(bytes);
  }

  async function materialize(s: Seeded, stepOrder = s.pending.stepOrder) {
    return s.t.run(async (ctx) => {
      const before = await ctx.meta.getTransactionMetrics();
      const result = await getStreamingMessagesWithMetadata(
        ctx,
        { threadId: s.threadId, order: s.pending.order, stepOrder },
        { status: "failed", error: "interrupted" },
      );
      const after = await ctx.meta.getTransactionMetrics();
      const used = (k: keyof typeof after) => after[k].used - before[k].used;
      return {
        textLengths: result.messages.map((m) =>
          (m.message?.content as { text: string }[]).map((p) => p.text.length),
        ),
        statuses: result.messages.map((m) => [m.status, m.error]),
        failures: result.materializationFailures,
        streamsToRelease: result.streamsToRelease,
        reads: {
          documents: used("documentsRead"),
          bytes: used("bytesRead"),
          queries: used("databaseQueries"),
        },
        writes: {
          documents: used("documentsWritten"),
          bytes: used("bytesWritten"),
        },
      };
    });
  }

  const fill = (count: number, size = 1) =>
    Array.from({ length: count }, () => "x".repeat(size));
  const budgetFailure = (streamId: Id<"streamingMessages">) => ({
    messages: [],
    failures: [
      {
        streamId,
        reason: `Delta logs for order 0 exceed the ${MAX_MATERIALIZATION_BYTES} byte or ${MAX_MATERIALIZATION_ROWS} document recovery budget at stream ${streamId}`,
      },
    ],
  });

  test("reads each stream's whole delta log, newest step first", async () => {
    const s = await seed([
      { stepOrder: 0, deltas: fill(3) },
      { stepOrder: 1, deltas: fill(1500) },
      { stepOrder: 1, deltas: fill(2, 10) },
      { stepOrder: 1, deltas: fill(700) },
    ]);
    const [older, ...newer] = s.streamIds;
    expect(await materialize(s, 1)).toEqual({
      textLengths: [[700], [20], [1500]],
      statuses: [
        ["failed", "interrupted"],
        ["failed", "interrupted"],
        ["failed", "interrupted"],
      ],
      failures: [],
      streamsToRelease: [...newer.reverse(), older],
      reads: { documents: 2213, bytes: 396213, queries: 7 },
      writes: { documents: 0, bytes: 0 },
    });
  });

  test("reads nothing past the streams when there are none", async () => {
    const s = await seed([]);
    expect(await materialize(s)).toEqual({
      textLengths: [],
      statuses: [],
      failures: [],
      streamsToRelease: [],
      reads: { documents: 0, bytes: 0, queries: 3 },
      writes: { documents: 0, bytes: 0 },
    });
  });

  test.each([
    { name: "one stream one row under", rows: [MAX_MATERIALIZATION_ROWS - 1] },
    { name: "one stream at", rows: [MAX_MATERIALIZATION_ROWS], failsAt: 0 },
    {
      name: "a second stream one row under the rest",
      rows: [1000, MAX_MATERIALIZATION_ROWS - 1000 - 1],
    },
    {
      name: "a second stream at the rest",
      rows: [1000, MAX_MATERIALIZATION_ROWS - 1000],
      failsAt: 1,
    },
  ])("row budget: $name", async ({ rows, failsAt }) => {
    // Streams at one step order are recovered newest first, so `rows` is
    // seeded in reverse to be read in order.
    const s = await seed(
      [...rows].reverse().map((n) => ({ deltas: fill(n - 1) })),
    );
    const result = await materialize(s);
    const order = [...s.streamIds].reverse();
    if (failsAt === undefined) {
      expect(result.failures).toEqual([]);
      expect(result.textLengths).toEqual(rows.map((n) => [n - 1]));
      expect(result.streamsToRelease).toEqual(order);
    } else {
      const streamId = order[failsAt]!;
      expect({
        messages: result.textLengths,
        failures: result.failures,
      }).toEqual(budgetFailure(streamId));
    }
    expect(result.reads.documents).toBe(
      rows.length + rows.reduce((a, b) => a + b, 0),
    );
    expect(result.writes).toEqual({ documents: 0, bytes: 0 });
  });

  test.each([
    { name: "one byte under", under: 1 },
    { name: "exactly at", under: 0 },
  ])("byte budget, first stream: $name", async ({ under }) => {
    const s = await seed([{ deltas: fill(8, 1_000_000) }]);
    const [streamId] = s.streamIds;
    await padTo(s, streamId!, MAX_MATERIALIZATION_BYTES - under);
    const result = await materialize(s);
    if (under) {
      expect(result.failures).toEqual([]);
      expect(result.streamsToRelease).toEqual([streamId]);
    } else {
      expect({
        messages: result.textLengths,
        failures: result.failures,
      }).toEqual(budgetFailure(streamId!));
    }
    expect(result.reads.documents).toBe(1 + 9);
    expect(result.writes).toEqual({ documents: 0, bytes: 0 });
  });

  test.each([
    { name: "one byte under", under: 1 },
    { name: "exactly at", under: 0 },
  ])("byte budget, second stream: $name", async ({ under }) => {
    const s = await seed([
      { deltas: fill(4, 1_000_000) },
      { deltas: fill(3, 1_000_000) },
    ]);
    const [second, first] = s.streamIds;
    const firstBytes = (await deltasOf(s, first!)).reduce(
      (n, d) => n + convexValueSize(d),
      0,
    );
    await padTo(s, second!, MAX_MATERIALIZATION_BYTES - firstBytes - under);
    const result = await materialize(s);
    if (under) {
      expect(result.failures).toEqual([]);
      expect(result.streamsToRelease).toEqual([first, second]);
    } else {
      expect({
        messages: result.textLengths,
        failures: result.failures,
      }).toEqual(budgetFailure(second!));
    }
    expect(result.reads.documents).toBe(2 + 4 + 5);
    expect(result.writes).toEqual({ documents: 0, bytes: 0 });
  });

  test("finalizeMessage recovers several streams in one transaction", async () => {
    const s = await seed([
      { deltas: fill(1500) },
      { deltas: fill(2, 10) },
      { deltas: fill(700) },
    ]);
    const metrics = await s.t.run(async (ctx) => {
      const before = await ctx.meta.getTransactionMetrics();
      await ctx.runMutation(api.messages.finalizeMessage, {
        messageId: s.pending._id as Id<"messages">,
        result: { status: "failed", error: "interrupted" },
      });
      const after = await ctx.meta.getTransactionMetrics();
      return Object.fromEntries(
        (["documentsRead", "databaseQueries", "documentsWritten"] as const).map(
          (k) => [k, after[k].used - before[k].used],
        ),
      );
    });
    const { page } = await s.t.query(api.messages.listMessagesByThreadId, {
      threadId: s.threadId,
      order: "asc",
    });
    expect(
      page.map((m) => [m.stepOrder, m.status, m.error, m.text?.length]),
    ).toEqual([
      [0, "failed", "interrupted", 700],
      [1, "failed", "interrupted", 20],
      [2, "failed", "interrupted", 1500],
    ]);
    expect(metrics).toEqual({
      documentsRead: 2218,
      databaseQueries: 20,
      documentsWritten: 3,
    });
  });
});
