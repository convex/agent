import { beforeEach, describe, expect, test } from "vitest";
import { createThread } from "../../client/threads.js";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import { streamText } from "ai";
import { components, initConvexTest } from "./setup.test.js";
import { mockModel } from "./mockModel.js";
import {
  compressUIMessageChunks,
  DeltaStreamer,
  mergeTransforms,
} from "./streaming.js";
import { getParts, deriveUIMessagesFromDeltas } from "../deltas.js";
import type { TestConvex } from "convex-test";
import type { StreamDelta, StreamMessage } from "../../validators.js";

const defaultTestOptions = {
  throttleMs: 0,
  abortSignal: undefined,
  compress: null,
  onAsyncAbort: async (_reason: string) => {
    // In integration tests, async aborts can happen when the stream
    // finishes before a pending delta write completes. This is expected.
  },
};

const testMetadata = {
  order: 0,
  stepOrder: 0,
  agentName: "test agent",
  model: "test model",
  provider: "test provider",
  providerOptions: {},
  format: "UIMessageChunk" as const,
};

// ============================================================================
// HTTP Streaming Initiation
// ============================================================================

describe("HTTP Streaming Initiation", () => {
  let t: TestConvex<SchemaDefinition<GenericSchema, boolean>>;
  let threadId: string;

  beforeEach(async () => {
    t = initConvexTest();
    await t.action(async (ctx) => {
      threadId = await createThread(ctx, components.agent, {});
    });
  });

  test("DeltaStreamer creates a stream on first addParts call", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );

      expect(streamer.streamId).toBeUndefined();

      await streamer.addParts([{ type: "start" }]);
      expect(streamer.streamId).toBeDefined();
    });
  });

  test("DeltaStreamer.getStreamId creates the stream lazily", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );

      expect(streamer.streamId).toBeUndefined();
      const streamId = await streamer.getStreamId();
      expect(streamId).toBeDefined();
      expect(streamer.streamId).toBe(streamId);
    });
  });

  test("DeltaStreamer.getStreamId returns the same ID on repeated calls", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );

      const id1 = await streamer.getStreamId();
      const id2 = await streamer.getStreamId();
      expect(id1).toBe(id2);
    });
  });

  test("Stream is created with streaming state", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );

      await streamer.getStreamId();

      const streams = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming"],
      });
      expect(streams).toHaveLength(1);
      expect(streams[0].status).toBe("streaming");
      expect(streams[0].agentName).toBe("test agent");
      expect(streams[0].model).toBe("test model");
    });
  });

  test("consumeStream processes full AI SDK stream to deltas", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );

      const result = streamText({
        model: mockModel({
          content: [{ type: "text", text: "Hello world" }],
        }),
        prompt: "Test",
      });

      await streamer.consumeStream(result.toUIMessageStream());
      // Ensure the AI SDK result is also fully consumed
      await result.consumeStream();
      expect(streamer.streamId).toBeDefined();

      // Verify deltas were saved
      const deltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [{ cursor: 0, streamId: streamer.streamId! }],
      });
      expect(deltas.length).toBeGreaterThan(0);

      // Verify we can reconstruct the text from deltas
      const { parts } = getParts(deltas);
      const textParts = parts.filter((p: any) => p.type === "text-delta");
      expect(textParts.length).toBeGreaterThan(0);
    });
  });

  test("consumeStream transitions stream to finished state", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );

      const result = streamText({
        model: mockModel({
          content: [{ type: "text", text: "Done" }],
        }),
        prompt: "Test",
      });

      await streamer.consumeStream(result.toUIMessageStream());

      // Stream should now be finished
      const streamingStreams = await ctx.runQuery(
        components.agent.streams.list,
        { threadId, statuses: ["streaming"] },
      );
      expect(streamingStreams).toHaveLength(0);

      const finishedStreams = await ctx.runQuery(
        components.agent.streams.list,
        { threadId, statuses: ["finished"] },
      );
      expect(finishedStreams).toHaveLength(1);
      expect(finishedStreams[0].status).toBe("finished");
    });
  });

  test("finishHandledExternally prevents consumeStream from calling finish", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions, finishHandledExternally: true },
        { ...testMetadata, threadId },
      );

      await streamer.getStreamId();

      const result = streamText({
        model: mockModel({
          content: [{ type: "text", text: "Hello" }],
        }),
        prompt: "Test",
      });

      await streamer.consumeStream(result.toUIMessageStream());

      // Stream should still be in streaming state since finish was skipped
      const streamingStreams = await ctx.runQuery(
        components.agent.streams.list,
        { threadId, statuses: ["streaming"] },
      );
      expect(streamingStreams).toHaveLength(1);

      // ...but the parts still made it into deltas, since the row kept
      // accepting until end-of-stream.
      const deltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [{ streamId: streamer.streamId!, cursor: 0 }],
      });
      const types = deltas.flatMap((d) => d.parts).map((p) => p.type);
      expect(types.at(0)).toBe("start");
      expect(types.at(-1)).toBe("finish");
    });
  });

  test("flushAndStopAccepting drops later parts but keeps the row streaming", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions, finishHandledExternally: true },
        { ...testMetadata, threadId },
      );

      await streamer.addParts([{ type: "start" }]);
      await streamer.flushAndStopAccepting();
      await streamer.addParts([{ type: "finish" }]);

      const deltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [{ streamId: streamer.streamId!, cursor: 0 }],
      });
      const types = deltas.flatMap((d) => d.parts).map((p) => p.type);
      expect(types).toEqual(["start"]);

      const streamingStreams = await ctx.runQuery(
        components.agent.streams.list,
        { threadId, statuses: ["streaming"] },
      );
      expect(streamingStreams).toHaveLength(1);
    });
  });
});

// ============================================================================
// Stream Exclusion Logic
// ============================================================================

describe("Stream Exclusion Logic", () => {
  let t: TestConvex<SchemaDefinition<GenericSchema, boolean>>;
  let threadId: string;

  beforeEach(async () => {
    t = initConvexTest();
    await t.action(async (ctx) => {
      threadId = await createThread(ctx, components.agent, {});
    });
  });

  test("list defaults to only streaming status", async () => {
    await t.action(async (ctx) => {
      // Create a stream and finish it
      const streamer1 = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId, order: 0 },
      );
      const r1 = streamText({
        model: mockModel({ content: [{ type: "text", text: "Finished" }] }),
        prompt: "Test",
      });
      await streamer1.consumeStream(r1.toUIMessageStream());

      // Create a still-streaming stream
      const streamer2 = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId, order: 1 },
      );
      await streamer2.getStreamId();
      await streamer2.addParts([{ type: "start" }]);

      // Default list: only streaming
      const defaultStreams = await ctx.runQuery(components.agent.streams.list, {
        threadId,
      });
      expect(defaultStreams).toHaveLength(1);
      expect(defaultStreams[0].status).toBe("streaming");
      expect(defaultStreams[0].order).toBe(1);
    });
  });

  test("list with includeStatuses filters correctly", async () => {
    await t.action(async (ctx) => {
      // Create and finish a stream
      const finishedStreamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId, order: 0 },
      );
      const r = streamText({
        model: mockModel({ content: [{ type: "text", text: "Done" }] }),
        prompt: "Test",
      });
      await finishedStreamer.consumeStream(r.toUIMessageStream());

      // Create and abort a stream
      const abortedStreamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId, order: 1 },
      );
      await abortedStreamer.getStreamId();
      await abortedStreamer.fail("test abort");

      // Create a still-streaming stream
      const activeStreamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId, order: 2 },
      );
      await activeStreamer.getStreamId();

      // Query for all statuses
      const allStreams = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming", "finished", "aborted"],
      });
      expect(allStreams).toHaveLength(3);

      // Query for only finished
      const finishedStreams = await ctx.runQuery(
        components.agent.streams.list,
        { threadId, statuses: ["finished"] },
      );
      expect(finishedStreams).toHaveLength(1);
      expect(finishedStreams[0].status).toBe("finished");

      // Query for only aborted
      const abortedStreams = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["aborted"],
      });
      expect(abortedStreams).toHaveLength(1);
      expect(abortedStreams[0].status).toBe("aborted");

      // Query for streaming + aborted
      const streamingAndAborted = await ctx.runQuery(
        components.agent.streams.list,
        { threadId, statuses: ["streaming", "aborted"] },
      );
      expect(streamingAndAborted).toHaveLength(2);
    });
  });

  test("startOrder filters out streams with lower order", async () => {
    await t.action(async (ctx) => {
      // Create streams at different orders
      for (const order of [0, 1, 2, 3]) {
        const streamer = new DeltaStreamer(
          components.agent,
          ctx,
          { ...defaultTestOptions },
          { ...testMetadata, threadId, order },
        );
        await streamer.getStreamId();
      }

      // startOrder=2 should only return streams with order >= 2
      const filtered = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        startOrder: 2,
        statuses: ["streaming"],
      });
      expect(filtered).toHaveLength(2);
      expect(filtered.every((s) => s.order >= 2)).toBe(true);
    });
  });

  test("streams from different threads are isolated", async () => {
    let threadId2: string;
    await t.action(async (ctx) => {
      threadId2 = await createThread(ctx, components.agent, {});

      // Create a stream in thread 1
      const s1 = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId, order: 0 },
      );
      await s1.getStreamId();

      // Create a stream in thread 2
      const s2 = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId: threadId2, order: 0 },
      );
      await s2.getStreamId();

      // Each thread should only see its own streams
      const t1Streams = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming"],
      });
      expect(t1Streams).toHaveLength(1);

      const t2Streams = await ctx.runQuery(components.agent.streams.list, {
        threadId: threadId2,
        statuses: ["streaming"],
      });
      expect(t2Streams).toHaveLength(1);

      expect(t1Streams[0].streamId).not.toBe(t2Streams[0].streamId);
    });
  });
});

// ============================================================================
// Delta Stream Consumption
// ============================================================================

describe("Delta Stream Consumption", () => {
  let t: TestConvex<SchemaDefinition<GenericSchema, boolean>>;
  let threadId: string;

  beforeEach(async () => {
    t = initConvexTest();
    await t.action(async (ctx) => {
      threadId = await createThread(ctx, components.agent, {});
    });
  });

  test("cursor-based incremental delta fetching", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );

      const result = streamText({
        model: mockModel({
          content: [{ type: "text", text: "One Two Three Four" }],
        }),
        prompt: "Test",
      });
      await streamer.consumeStream(result.toUIMessageStream());
      const streamId = streamer.streamId!;

      // Fetch all deltas from start
      const allDeltas = await ctx.runQuery(
        components.agent.streams.listDeltas,
        { threadId, cursors: [{ cursor: 0, streamId }] },
      );
      expect(allDeltas.length).toBeGreaterThan(0);
      const { parts: allParts, cursor: endCursor } = getParts(allDeltas);

      // Fetch from midpoint cursor - should only get remaining deltas
      const midCursor = Math.floor(endCursor / 2);
      const laterDeltas = await ctx.runQuery(
        components.agent.streams.listDeltas,
        { threadId, cursors: [{ cursor: midCursor, streamId }] },
      );
      const { parts: laterParts } = getParts(laterDeltas, midCursor);

      // Later parts should be a subset of all parts
      expect(laterParts.length).toBeLessThanOrEqual(allParts.length);

      // Fetching from the end cursor should yield nothing
      const noDeltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [{ cursor: endCursor, streamId }],
      });
      expect(noDeltas).toHaveLength(0);
    });
  });

  test("multi-stream delta fetching with separate cursors", async () => {
    await t.action(async (ctx) => {
      // Create two streams with different content
      const streamer1 = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId, order: 0 },
      );
      const r1 = streamText({
        model: mockModel({ content: [{ type: "text", text: "Stream One" }] }),
        prompt: "Test 1",
      });
      await streamer1.consumeStream(r1.toUIMessageStream());

      const streamer2 = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId, order: 1 },
      );
      const r2 = streamText({
        model: mockModel({ content: [{ type: "text", text: "Stream Two" }] }),
        prompt: "Test 2",
      });
      await streamer2.consumeStream(r2.toUIMessageStream());

      const id1 = streamer1.streamId!;
      const id2 = streamer2.streamId!;

      // Fetch deltas for both streams simultaneously
      const deltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [
          { cursor: 0, streamId: id1 },
          { cursor: 0, streamId: id2 },
        ],
      });

      // Should have deltas for both streams
      const s1Deltas = deltas.filter((d) => d.streamId === id1);
      const s2Deltas = deltas.filter((d) => d.streamId === id2);
      expect(s1Deltas.length).toBeGreaterThan(0);
      expect(s2Deltas.length).toBeGreaterThan(0);
    });
  });

  test("deriveUIMessagesFromDeltas reconstructs messages from UIMessageChunk format", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );

      const result = streamText({
        model: mockModel({
          content: [{ type: "text", text: "Hello from deltas" }],
        }),
        prompt: "Test",
      });
      await streamer.consumeStream(result.toUIMessageStream());
      const streamId = streamer.streamId!;

      // Fetch stream messages and deltas
      const streams = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["finished"],
      });
      const deltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [{ cursor: 0, streamId }],
      });

      // Derive UI messages
      const uiMessages = await deriveUIMessagesFromDeltas(
        threadId,
        streams,
        deltas,
      );
      expect(uiMessages).toHaveLength(1);
      expect(uiMessages[0].role).toBe("assistant");
      expect(uiMessages[0].text).toContain("Hello");
      expect(uiMessages[0].text).toContain("from");
      expect(uiMessages[0].text).toContain("deltas");
    });
  });

  test("compression merges consecutive text deltas", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        {
          throttleMs: 1000,
          abortSignal: undefined,
          compress: compressUIMessageChunks,
          onAsyncAbort: async () => {
            throw new Error("async abort");
          },
        },
        { ...testMetadata, threadId },
      );

      const result = streamText({
        model: mockModel({
          content: [
            { type: "text", text: "A B C" },
            { type: "reasoning", text: "X Y Z" },
          ],
        }),
        prompt: "Test",
      });
      await streamer.consumeStream(result.toUIMessageStream());
      const streamId = streamer.streamId!;

      const deltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [{ cursor: 0, streamId }],
      });
      const { parts } = getParts(deltas);

      // Compressed: all text-deltas for one text section should be merged
      const textDeltas = parts.filter((p: any) => p.type === "text-delta");
      // With compression and throttleMs=1000, text deltas should be merged
      expect(textDeltas.length).toBeLessThanOrEqual(1);
      if (textDeltas.length === 1) {
        expect((textDeltas[0] as { delta: string }).delta).toBe("A B C");
      }

      // Reasoning deltas should also be merged
      const reasoningDeltas = parts.filter(
        (p: any) => p.type === "reasoning-delta",
      );
      expect(reasoningDeltas.length).toBeLessThanOrEqual(1);
    });
  });

  test("getParts validates delta continuity", () => {
    const streamId = "test-stream";

    // Normal continuous deltas
    const deltas: StreamDelta[] = [
      { streamId, start: 0, end: 3, parts: [{ type: "text-delta" }] },
      { streamId, start: 3, end: 6, parts: [{ type: "text-delta" }] },
      { streamId, start: 6, end: 9, parts: [{ type: "text-delta" }] },
    ];
    const { parts, cursor } = getParts(deltas);
    expect(parts).toHaveLength(3);
    expect(cursor).toBe(9);
  });

  test("getParts handles gap in deltas gracefully", () => {
    const streamId = "test-stream";

    // Deltas with a gap (missing 3-6)
    const deltas: StreamDelta[] = [
      { streamId, start: 0, end: 3, parts: [{ type: "a" }] },
      { streamId, start: 6, end: 9, parts: [{ type: "b" }] },
    ];
    const { parts, cursor } = getParts(deltas);
    // Should stop at the gap
    expect(parts).toHaveLength(1);
    expect(cursor).toBe(3);
  });

  test("getParts skips already-consumed deltas", () => {
    const streamId = "test-stream";
    const deltas: StreamDelta[] = [
      { streamId, start: 0, end: 3, parts: [{ type: "old" }] },
      { streamId, start: 3, end: 6, parts: [{ type: "new" }] },
    ];
    // Start from cursor=3 to skip first delta
    const { parts, cursor } = getParts(deltas, 3);
    expect(parts).toHaveLength(1);
    expect((parts[0] as { type: string }).type).toBe("new");
    expect(cursor).toBe(6);
  });
});

// ============================================================================
// Fallback Behavior between HTTP and Delta Streams
// ============================================================================

describe("Fallback Behavior", () => {
  let t: TestConvex<SchemaDefinition<GenericSchema, boolean>>;
  let threadId: string;

  beforeEach(async () => {
    t = initConvexTest();
    await t.action(async (ctx) => {
      threadId = await createThread(ctx, components.agent, {});
    });
  });

  test("aborted stream transitions to aborted state", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );
      await streamer.getStreamId();

      await streamer.fail("User canceled");

      const aborted = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["aborted"],
      });
      expect(aborted).toHaveLength(1);
      expect(aborted[0].status).toBe("aborted");

      // No streaming streams left
      const streaming = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming"],
      });
      expect(streaming).toHaveLength(0);
    });
  });

  test("abort via abortByOrder aborts all streams at that order", async () => {
    await t.action(async (ctx) => {
      // Create two streams at the same order (different stepOrders)
      const s1 = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId, order: 5, stepOrder: 0 },
      );
      await s1.getStreamId();

      const s2 = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId, order: 5, stepOrder: 1 },
      );
      await s2.getStreamId();

      // Abort by order
      const result = await ctx.runMutation(
        components.agent.streams.abortByOrder,
        { threadId, order: 5, reason: "batch abort" },
      );
      expect(result).toBe(true);

      const streaming = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming"],
      });
      expect(streaming).toHaveLength(0);

      const aborted = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["aborted"],
      });
      expect(aborted).toHaveLength(2);
    });
  });

  test("fail on already-aborted stream is a no-op", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );
      await streamer.getStreamId();

      // First abort
      await streamer.fail("First abort");

      // Second abort is a no-op (no error thrown)
      await streamer.fail("Second abort");

      const aborted = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["aborted"],
      });
      expect(aborted).toHaveLength(1);
    });
  });

  test("finish on non-existent stream is a no-op", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );

      // Calling finish without ever creating a stream should be safe
      await streamer.finish();
      expect(streamer.streamId).toBeUndefined();
    });
  });

  test("deriveUIMessagesFromDeltas maps stream status correctly", async () => {
    // Streaming status
    const streamingMsg: StreamMessage = {
      streamId: "s1",
      order: 0,
      stepOrder: 0,
      status: "streaming",
      format: "UIMessageChunk",
    };
    const finishedMsg: StreamMessage = {
      streamId: "s2",
      order: 1,
      stepOrder: 0,
      status: "finished",
      format: "UIMessageChunk",
    };
    const abortedMsg: StreamMessage = {
      streamId: "s3",
      order: 2,
      stepOrder: 0,
      status: "aborted",
      format: "UIMessageChunk",
    };

    const msgs = await deriveUIMessagesFromDeltas(
      "t1",
      [streamingMsg, finishedMsg, abortedMsg],
      [],
    );
    expect(msgs[0].status).toBe("streaming");
    expect(msgs[1].status).toBe("success");
    expect(msgs[2].status).toBe("failed");
  });

  test("mergeTransforms adds smoothStream when streaming is enabled", () => {
    // No streaming options - returns existing transforms
    expect(mergeTransforms(undefined, undefined)).toBeUndefined();

    // Boolean true - adds smoothStream
    const transforms = mergeTransforms(true, undefined);
    expect(transforms).toBeDefined();
    expect(Array.isArray(transforms)).toBe(true);
    expect((transforms as any[]).length).toBe(1);

    // With existing transforms - appends
    const existing = [(chunk: any) => chunk];
    const merged = mergeTransforms(true, existing);
    expect(Array.isArray(merged)).toBe(true);
    expect((merged as any[]).length).toBe(2);

    // Custom chunking
    const custom = mergeTransforms({ chunking: "word" }, undefined);
    expect(custom).toBeDefined();
    expect(Array.isArray(custom)).toBe(true);
  });
});

// ============================================================================
// Stream Lifecycle Integration
// ============================================================================

describe("Stream Lifecycle Integration", () => {
  let t: TestConvex<SchemaDefinition<GenericSchema, boolean>>;
  let threadId: string;

  beforeEach(async () => {
    t = initConvexTest();
    await t.action(async (ctx) => {
      threadId = await createThread(ctx, components.agent, {});
    });
  });

  test("full lifecycle: create -> stream -> finish -> derive messages", async () => {
    await t.action(async (ctx) => {
      // 1. Create the stream
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );

      // 2. Stream content
      const result = streamText({
        model: mockModel({
          content: [
            { type: "text", text: "Once upon a time" },
            { type: "reasoning", text: "I should tell a story" },
          ],
        }),
        prompt: "Tell me a story",
      });
      await streamer.consumeStream(result.toUIMessageStream());
      const streamId = streamer.streamId!;

      // 3. Verify finish state
      const finished = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["finished"],
      });
      expect(finished).toHaveLength(1);

      // 4. Derive UI messages from stored deltas
      const deltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [{ cursor: 0, streamId }],
      });
      const uiMessages = await deriveUIMessagesFromDeltas(
        threadId,
        finished,
        deltas,
      );

      expect(uiMessages).toHaveLength(1);
      const msg = uiMessages[0];
      expect(msg.role).toBe("assistant");
      expect(msg.text).toContain("Once");
      expect(msg.text).toContain("upon");
      expect(msg.text).toContain("time");
      expect(msg.status).toBe("success");

      // Check that reasoning parts are present
      const reasoningParts = msg.parts.filter(
        (p: any) => p.type === "reasoning",
      );
      expect(reasoningParts.length).toBeGreaterThan(0);
    });
  });

  test("full lifecycle: create -> partial stream -> abort -> derive aborted messages", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );

      // Stream some content then abort
      await streamer.addParts([
        { type: "start" },
        { type: "start-step" },
        { type: "text-start", id: "txt-0" },
        { type: "text-delta", id: "txt-0", delta: "Partial" },
      ]);
      await streamer.fail("User aborted");

      const streamId = streamer.streamId!;

      // Verify aborted state
      const aborted = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["aborted"],
      });
      expect(aborted).toHaveLength(1);
      expect(aborted[0].status).toBe("aborted");

      // Even aborted streams have their deltas stored
      const deltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [{ cursor: 0, streamId }],
      });
      expect(deltas.length).toBeGreaterThan(0);
    });
  });

  test("multiple concurrent streams in same thread", async () => {
    await t.action(async (ctx) => {
      const streamers = [];
      for (let i = 0; i < 3; i++) {
        const streamer = new DeltaStreamer(
          components.agent,
          ctx,
          { ...defaultTestOptions },
          { ...testMetadata, threadId, order: i },
        );
        const r = streamText({
          model: mockModel({
            content: [{ type: "text", text: `Message ${i}` }],
          }),
          prompt: "Test",
        });
        await streamer.consumeStream(r.toUIMessageStream());
        streamers.push(streamer);
      }

      // All should be finished
      const finished = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["finished"],
      });
      expect(finished).toHaveLength(3);

      // Derive all messages
      const allDeltas = await ctx.runQuery(
        components.agent.streams.listDeltas,
        {
          threadId,
          cursors: streamers.map((s) => ({
            cursor: 0,
            streamId: s.streamId!,
          })),
        },
      );
      const uiMessages = await deriveUIMessagesFromDeltas(
        threadId,
        finished,
        allDeltas,
      );
      expect(uiMessages).toHaveLength(3);
    });
  });

  test("stream deletion removes both stream and its deltas", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );
      const r = streamText({
        model: mockModel({ content: [{ type: "text", text: "Delete me" }] }),
        prompt: "Test",
      });
      await streamer.consumeStream(r.toUIMessageStream());
      const streamId = streamer.streamId!;

      // Verify deltas exist
      const beforeDeltas = await ctx.runQuery(
        components.agent.streams.listDeltas,
        { threadId, cursors: [{ cursor: 0, streamId }] },
      );
      expect(beforeDeltas.length).toBeGreaterThan(0);

      // Delete the stream
      await ctx.runMutation(components.agent.streams.deleteStreamSync, {
        streamId,
      });

      // Both stream and deltas should be gone
      const afterStreams = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming", "finished", "aborted"],
      });
      expect(afterStreams).toHaveLength(0);

      const afterDeltas = await ctx.runQuery(
        components.agent.streams.listDeltas,
        { threadId, cursors: [{ cursor: 0, streamId }] },
      );
      expect(afterDeltas).toHaveLength(0);
    });
  });
});

// ============================================================================
// Compression
// ============================================================================

describe("Compression", () => {
  test("compressUIMessageChunks merges consecutive text-delta parts", () => {
    const parts = [
      { type: "text-delta" as const, id: "1", delta: "Hello" },
      { type: "text-delta" as const, id: "1", delta: " " },
      { type: "text-delta" as const, id: "1", delta: "World" },
    ];
    const compressed = compressUIMessageChunks(parts);
    expect(compressed).toHaveLength(1);
    expect(compressed[0]).toEqual({
      type: "text-delta",
      id: "1",
      delta: "Hello World",
    });
  });

  test("compressUIMessageChunks does not merge different IDs", () => {
    const parts = [
      { type: "text-delta" as const, id: "1", delta: "Hello" },
      { type: "text-delta" as const, id: "2", delta: "World" },
    ];
    const compressed = compressUIMessageChunks(parts);
    expect(compressed).toHaveLength(2);
  });

  test("compressUIMessageChunks merges consecutive reasoning-delta parts", () => {
    const parts = [
      { type: "reasoning-delta" as const, id: "r1", delta: "Think" },
      { type: "reasoning-delta" as const, id: "r1", delta: "ing" },
    ];
    const compressed = compressUIMessageChunks(parts);
    expect(compressed).toHaveLength(1);
    expect((compressed[0] as { delta: string }).delta).toBe("Thinking");
  });

  test("compressUIMessageChunks preserves non-delta parts", () => {
    const parts = [
      { type: "start" as const },
      { type: "text-delta" as const, id: "1", delta: "A" },
      { type: "text-delta" as const, id: "1", delta: "B" },
      { type: "finish" as const },
    ];
    const compressed = compressUIMessageChunks(parts as any);
    expect(compressed).toHaveLength(3); // start, merged text, finish
  });
});
