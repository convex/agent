import { beforeEach, describe, expect, test, vi } from "vitest";
import { createThread } from "../../client/threads.js";
import type { MutationCtx } from "../../client/types.js";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import { streamText } from "ai";
import { components, initConvexTest } from "./setup.test.js";
import { mockModel } from "./mockModel.js";
import {
  compressUIMessageChunks,
  DeltaStreamer,
  syncStreams,
} from "./streaming.js";
import { getParts } from "../deltas.js";
import type { TestConvex } from "convex-test";

const defaultTestOptions = {
  throttleMs: 0,
  abortSignal: undefined,
  compress: null,
  onAsyncAbort: async () => {
    throw new Error("unexpected");
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

describe("syncStreams", () => {
  test.each(["first", "last"])(
    "rejects a mixed-thread request with the foreign stream %s",
    async (position) => {
      const t = initConvexTest();
      await t.action(async (ctx) => {
        const threadId = await createThread(ctx, components.agent, {});
        const otherThreadId = await createThread(ctx, components.agent, {});
        const cursors = [];
        for (const id of [threadId, otherThreadId]) {
          const streamId = await ctx.runMutation(
            components.agent.streams.create,
            {
              ...testMetadata,
              threadId: id,
            },
          );
          await ctx.runMutation(components.agent.streams.addDelta, {
            streamId,
            start: 0,
            end: 1,
            parts: [id === threadId ? "allowed" : "private"],
          });
          cursors.push({ streamId, cursor: 0 });
        }
        if (position === "first") cursors.reverse();

        await expect(
          syncStreams(ctx, components.agent, {
            threadId,
            streamArgs: { kind: "deltas", cursors },
          }),
        ).rejects.toThrow("Stream does not belong to the given thread");
      });
    },
  );

  test("returns same-thread deltas from each stream's cursor", async () => {
    const t = initConvexTest();
    await t.action(async (ctx) => {
      const threadId = await createThread(ctx, components.agent, {});
      const cursors = [];
      const expected = [];
      for (let stepOrder = 0; stepOrder < 2; stepOrder++) {
        const streamId = await ctx.runMutation(
          components.agent.streams.create,
          {
            ...testMetadata,
            threadId,
            stepOrder,
          },
        );
        for (let start = 0; start < 2; start++) {
          const delta = { streamId, start, end: start + 1, parts: ["allowed"] };
          await ctx.runMutation(components.agent.streams.addDelta, delta);
          if (start >= stepOrder) expected.push(delta);
        }
        cursors.push({ streamId, cursor: stepOrder });
      }

      await expect(
        syncStreams(ctx, components.agent, {
          threadId,
          streamArgs: { kind: "deltas", cursors },
        }),
      ).resolves.toEqual({ kind: "deltas", deltas: expected });
    });
  });
});

describe("DeltaStreamer", () => {
  let t: TestConvex<SchemaDefinition<GenericSchema, boolean>>;
  let threadId: string;
  beforeEach(async () => {
    t = initConvexTest();
    await t.action(async (ctx) => {
      threadId = await createThread(ctx, components.agent, {});
    });
  });
  test("should save chunks via DeltaStreamer", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );
      const result = streamText({
        model: mockModel(),
        prompt: "Test prompt",
      });
      await streamer.consumeStream(result.toUIMessageStream());
      const streamId = streamer.streamId!;
      expect(streamId).toBeDefined();
      const deltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [{ cursor: 0, streamId }],
      });
      const { parts } = getParts(deltas);
      const stream = result.toUIMessageStream();
      for await (const part of stream) {
        const expected = parts.shift();
        expect(part).toEqual(expected);
      }
    });
  });
  test("should save all parts when throttleMs is 0", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        { ...defaultTestOptions, throttleMs: 0 },
        { ...testMetadata, threadId },
      );
      const result = streamText({
        model: mockModel({
          content: [
            // The mockModel splits these into deltas based on spaces
            { type: "text", text: "A B C" },
            { type: "reasoning", text: "D E F" },
          ],
        }),
        prompt: "Test prompt",
      });
      await streamer.consumeStream(result.toUIMessageStream());
      const streamId = streamer.streamId!;
      expect(streamId).toBeDefined();
      const deltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [{ cursor: 0, streamId }],
      });
      const { parts } = getParts(deltas);
      const expected = [
        { type: "start" },
        { type: "start-step" },
        { type: "text-start" },
        { type: "text-delta", delta: "A" },
        { type: "text-delta", delta: " B" },
        { type: "text-delta", delta: " C" },
        { type: "text-end" },
        { type: "reasoning-start" },
        { type: "reasoning-delta", delta: "D" },
        { type: "reasoning-delta", delta: " E" },
        { type: "reasoning-delta", delta: " F" },
        { type: "reasoning-end" },
        { type: "finish-step" },
        { type: "finish" },
      ];
      for (const expectedPart of expected) {
        const part = parts.shift();
        expect(part).toBeDefined();
        expect(part).toMatchObject(expectedPart);
      }
    });
  });

  test("should save compressed parts via DeltaStreamer", async () => {
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
        {
          ...testMetadata,
          threadId,
        },
      );
      const result = streamText({
        model: mockModel({
          content: [
            // The mockModel splits these into deltas based on spaces
            { type: "text", text: "A B C" },
            { type: "text", text: "D E F" },
            { type: "reasoning", text: "J K L" },
            { type: "text", text: "M N O" },
          ],
        }),
        prompt: "Test prompt",
        // experimental_transform: smoothStream({ chunking: "line" }),
        onError: (error) => {
          console.error(error);
        },
      });
      await streamer.consumeStream(result.toUIMessageStream());
      const streamId = streamer.streamId!;
      expect(streamId).toBeDefined();
      const deltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [{ cursor: 0, streamId }],
      });
      const { parts } = getParts(deltas);
      const expected = [
        { type: "start" },
        { type: "start-step" },
        { type: "text-start" },
        // These are collapsed into a single delta
        { type: "text-delta", delta: "A B C" },
        { type: "text-end" },
        { type: "text-start" },
        { type: "text-delta", delta: "D E F" },
        { type: "text-end" },
        { type: "reasoning-start" },
        { type: "reasoning-delta", delta: "J K L" },
        { type: "reasoning-end" },
        { type: "text-start" },
        { type: "text-delta", delta: "M N O" },
        { type: "text-end" },
        { type: "finish-step" },
        { type: "finish" },
      ];
      for (const expectedPart of expected) {
        const part = parts.shift();
        expect(part).toBeDefined();
        expect(part).toMatchObject(expectedPart);
      }
    });
  });
  test("honors a signal that was aborted before construction", async () => {
    const abortController = new AbortController();
    abortController.abort();

    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer<string>(
        components.agent,
        ctx,
        { ...defaultTestOptions, abortSignal: abortController.signal },
        { ...testMetadata, threadId },
      );

      expect(streamer.abortController.signal.aborted).toBe(true);
      await streamer.addParts(["ignored"]);
      expect(streamer.streamId).toBeUndefined();
      await expect(
        streamer.getOrCreateStreamId({ ifAborted: "returnUndefined" }),
      ).resolves.toBeUndefined();
      await expect(streamer.getOrCreateStreamId()).rejects.toThrow(
        "Cannot create a stream after it has been aborted",
      );
      await expect(streamer.getStreamId()).rejects.toThrow(
        "Cannot create a stream after it has been aborted",
      );
    });
  });

  test("preserves the public throwing behavior after an existing stream aborts", async () => {
    await t.action(async (ctx) => {
      const streamer = new DeltaStreamer<string>(
        components.agent,
        ctx,
        { ...defaultTestOptions },
        { ...testMetadata, threadId },
      );
      const streamId = await streamer.getStreamId();

      await streamer.fail("provider error");

      expect(streamer.streamId).toBe(streamId);
      await expect(streamer.getStreamId()).rejects.toThrow(
        "Cannot create a stream after it has been aborted",
      );
      await expect(streamer.getOrCreateStreamId()).rejects.toThrow(
        "Cannot create a stream after it has been aborted",
      );
      await expect(
        streamer.getOrCreateStreamId({ ifAborted: "returnUndefined" }),
      ).resolves.toBeUndefined();
    });
  });

  test("does not return an ID when abort wins during stream creation", async () => {
    let resolveCreate!: (streamId: string) => void;
    const creatingStream = new Promise<string>((resolve) => {
      resolveCreate = resolve;
    });
    const runMutation = vi
      .fn()
      .mockImplementationOnce(() => creatingStream)
      .mockResolvedValueOnce(true);
    const streamer = new DeltaStreamer<string>(
      components.agent,
      { runMutation } as unknown as MutationCtx,
      { ...defaultTestOptions },
      { ...testMetadata, threadId },
    );

    const getting = streamer.getOrCreateStreamId({
      ifAborted: "returnUndefined",
    });
    const failing = streamer.fail("provider error");
    resolveCreate("stream-1");

    await failing;
    await expect(getting).resolves.toBeUndefined();
    expect(streamer.streamId).toBe("stream-1");
    await expect(streamer.getStreamId()).rejects.toThrow(
      "Cannot create a stream after it has been aborted",
    );
  });

  test("shares signal and fail cleanup while stream creation is in flight", async () => {
    let resolveCreate!: (streamId: string) => void;
    const creatingStream = new Promise<string>((resolve) => {
      resolveCreate = resolve;
    });
    let resolveAbort!: () => void;
    const abortingStream = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const runMutation = vi
      .fn()
      .mockImplementationOnce(() => creatingStream)
      .mockImplementationOnce(() => abortingStream);
    const abortController = new AbortController();
    const streamer = new DeltaStreamer<string>(
      components.agent,
      { runMutation } as unknown as MutationCtx,
      { ...defaultTestOptions, abortSignal: abortController.signal },
      { ...testMetadata, threadId },
    );

    const streamId = streamer.getStreamId();
    abortController.abort();
    const failing = streamer.fail("creation failed");
    let failSettled = false;
    void failing.then(() => {
      failSettled = true;
    });
    resolveCreate("stream-1");
    await expect(streamId).resolves.toBe("stream-1");
    await vi.waitFor(() => expect(runMutation).toHaveBeenCalledTimes(2));

    expect(failSettled).toBe(false);
    resolveAbort();
    await failing;

    expect(runMutation).toHaveBeenNthCalledWith(
      2,
      components.agent.streams.abort,
      { streamId: "stream-1", reason: "abortSignal" },
    );
  });

  test("waits for signal cleanup when the source throws", async () => {
    let resolveDelta!: (value: boolean) => void;
    const deltaWrite = new Promise<boolean>((resolve) => {
      resolveDelta = resolve;
    });
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce("stream-1")
      .mockImplementationOnce(() => deltaWrite)
      .mockResolvedValueOnce(undefined);
    const abortController = new AbortController();
    const streamer = new DeltaStreamer<string>(
      components.agent,
      { runMutation } as unknown as MutationCtx,
      { ...defaultTestOptions, abortSignal: abortController.signal },
      { ...testMetadata, threadId },
    );
    const sourceError = new Error("provider aborted");
    const source = {
      async *[Symbol.asyncIterator]() {
        yield "chunk";
        abortController.abort();
        throw sourceError;
      },
    } as unknown as Parameters<typeof streamer.consumeStream>[0];

    const consuming = streamer.consumeStream(source);
    let settled = false;
    void consuming.catch(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(runMutation).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);

    resolveDelta(true);
    await expect(consuming).rejects.toBe(sourceError);
    expect(runMutation).toHaveBeenNthCalledWith(
      3,
      components.agent.streams.abort,
      { streamId: "stream-1", reason: "abortSignal" },
    );
  });

  test("aborts the component stream when a delta write fails", async () => {
    const deltaFailure = {
      error: { code: "provider_disconnected", message: "Provider dropped" },
    };
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce("stream-1")
      .mockRejectedValueOnce(deltaFailure)
      .mockResolvedValueOnce(undefined);
    let abortReason: string | undefined;
    const streamer = new DeltaStreamer<string>(
      components.agent,
      { runMutation } as unknown as MutationCtx,
      {
        ...defaultTestOptions,
        onAsyncAbort: async (reason) => {
          abortReason = reason;
        },
      },
      { ...testMetadata, threadId },
    );

    await streamer.addParts(["A"]);
    await streamer.finish();

    expect(abortReason).toBe("provider_disconnected: Provider dropped");
    expect(runMutation).toHaveBeenNthCalledWith(
      3,
      components.agent.streams.abort,
      {
        streamId: "stream-1",
        reason: "provider_disconnected: Provider dropped",
      },
    );
  });

  test("aborts the component stream when file materialization fails", async () => {
    const materializationFailure = new Error("storage failed");
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce("stream-1")
      .mockResolvedValueOnce(undefined);
    const streamer = new DeltaStreamer<string>(
      components.agent,
      { runMutation } as unknown as MutationCtx,
      {
        ...defaultTestOptions,
        onAsyncAbort: async () => {},
        materialize: async () => {
          throw materializationFailure;
        },
      },
      { ...testMetadata, threadId },
    );

    await streamer.addParts(["A"]);
    await expect(streamer.finish()).resolves.toBeUndefined();
    expect(runMutation).toHaveBeenNthCalledWith(
      2,
      components.agent.streams.abort,
      { streamId: "stream-1", reason: "storage failed" },
    );
  });

  test("surfaces pending-message cleanup failure after aborting the stream", async () => {
    const pendingMessageFailure = new Error("pending message cleanup failed");
    let resolveComponentAbort!: () => void;
    const componentAborted = new Promise<void>((resolve) => {
      resolveComponentAbort = resolve;
    });
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce("stream-1")
      .mockRejectedValueOnce(new Error("delta failed"))
      .mockImplementationOnce(() => {
        resolveComponentAbort();
        return Promise.resolve();
      });
    const streamer = new DeltaStreamer<string>(
      components.agent,
      { runMutation } as unknown as MutationCtx,
      {
        ...defaultTestOptions,
        onAsyncAbort: async () => {
          throw pendingMessageFailure;
        },
      },
      { ...testMetadata, threadId },
    );
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield "A";
        await componentAborted;
      },
    } as unknown as Parameters<typeof streamer.consumeStream>[0];

    await expect(streamer.consumeStream(stream)).rejects.toBe(
      pendingMessageFailure,
    );

    expect(runMutation).toHaveBeenNthCalledWith(
      3,
      components.agent.streams.abort,
      { streamId: "stream-1", reason: "delta failed" },
    );
  });

  test("finishes external abort cleanup when the active delta write fails", async () => {
    const pendingMessageFailure = new Error("pending message cleanup failed");
    let rejectDelta!: (error: Error) => void;
    const deltaWrite = new Promise<never>((_, reject) => {
      rejectDelta = reject;
    });
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce("stream-1")
      .mockImplementationOnce(() => deltaWrite)
      .mockResolvedValueOnce(undefined);
    const streamer = new DeltaStreamer<string>(
      components.agent,
      { runMutation } as unknown as MutationCtx,
      {
        ...defaultTestOptions,
        onAsyncAbort: async () => {
          throw pendingMessageFailure;
        },
      },
      { ...testMetadata, threadId },
    );

    await streamer.addParts(["A"]);
    const failing = streamer.fail("external abort");
    rejectDelta(new Error("delta failed"));

    await expect(failing).rejects.toBe(pendingMessageFailure);
    expect(runMutation).toHaveBeenNthCalledWith(
      3,
      components.agent.streams.abort,
      { streamId: "stream-1", reason: "external abort" },
    );
  });
  // TODO: test fetching partial stream data - syncStreams w/ cursors

  test("does not drop a part parked in stream creation when the final step lands", async () => {
    let resolveCreate!: (streamId: string) => void;
    const creating = new Promise<string>((r) => (resolveCreate = r));
    const sent: unknown[] = [];
    const runMutation = vi
      .fn()
      .mockImplementationOnce(() => creating)
      .mockImplementation((_ref: unknown, args: unknown) => {
        sent.push(args);
        return Promise.resolve(true);
      });
    const streamer = new DeltaStreamer<string>(
      components.agent,
      { runMutation } as unknown as MutationCtx,
      { ...defaultTestOptions },
      { ...testMetadata, threadId },
    );

    // A part arrives and parks in streams.create.
    const adding = streamer.addParts(["A"]);
    // The final step lands while creation is still in flight.
    const finishing = streamer.flushAndStopAccepting();
    resolveCreate("stream-1");
    await Promise.all([adding, finishing]);

    expect(sent).toHaveLength(1);
    expect((sent[0] as { parts: string[] }).parts).toEqual(["A"]);
  });
});
