import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createThread } from "../../client/threads.js";
import { components, initConvexTest } from "./setup.test.js";
import { DeltaStreamer } from "./streaming.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

test("publishes a quiet tail after preparing an earlier batch takes time", async () => {
  const t = initConvexTest();
  let releasePreparation!: () => void;
  let enteredPreparation!: () => void;
  const preparing = new Promise<void>((resolve) => {
    enteredPreparation = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  await t.action(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, {});
    const streamer = new DeltaStreamer<string>(
      components.agent,
      ctx,
      {
        throttleMs: 100,
        compress: null,
        abortSignal: undefined,
        onAsyncAbort: async (reason) => {
          throw new Error(reason);
        },
        materialize: async (parts) => {
          if (parts.includes("first")) {
            enteredPreparation();
            await release;
          }
          return { parts, fileRefs: [] };
        },
      },
      { threadId, order: 0, stepOrder: 0, format: undefined },
    );
    const savedParts = async () => {
      const deltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [{ streamId: await streamer.getStreamId(), cursor: 0 }],
      });
      return deltas.flatMap((delta) => delta.parts);
    };
    try {
      await streamer.addParts(["first"]);
      await preparing;
      await streamer.addParts(["tail"]);
      await vi.advanceTimersByTimeAsync(250);
      expect(await savedParts()).toEqual([]);
      releasePreparation();
      for (let elapsed = 0; elapsed < 200; elapsed++) {
        await vi.advanceTimersByTimeAsync(1);
        if ((await savedParts()).includes("first")) break;
      }
      expect(await savedParts()).toEqual(["first"]);
      await vi.advanceTimersByTimeAsync(50);
      expect(await savedParts()).toEqual(["first"]);
      await vi.advanceTimersByTimeAsync(300);
      expect.soft(await savedParts()).toEqual(["first", "tail"]);
      const streams = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming"],
      });
      expect(streams).toHaveLength(1);
    } finally {
      releasePreparation();
      await streamer.finish();
    }
    expect(await savedParts()).toEqual(["first", "tail"]);
  });
});

test("a wake armed during a write respects the deadline that write set", async () => {
  const t = initConvexTest();
  let releasePreparation!: () => void;
  let enteredPreparation!: () => void;
  const preparing = new Promise<void>((resolve) => {
    enteredPreparation = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  await t.action(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, {});
    const streamer = new DeltaStreamer<string>(
      components.agent,
      ctx,
      {
        throttleMs: 100,
        compress: null,
        abortSignal: undefined,
        onAsyncAbort: async () => {},
        materialize: async (parts) => {
          if (parts.includes("first")) {
            enteredPreparation();
            await release;
          }
          return { parts, fileRefs: [] };
        },
      },
      { threadId, order: 0, stepOrder: 0, format: undefined },
    );
    const streamId = await streamer.getStreamId();
    const savedParts = async () => {
      const deltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [{ streamId, cursor: 0 }],
      });
      return deltas.flatMap((delta) => delta.parts);
    };

    await streamer.addParts(["first"]);
    await preparing;
    // The tail is admitted while the first batch is still being prepared, so
    // the wake it arms is measured against the previous write's deadline.
    await vi.advanceTimersByTimeAsync(10);
    await streamer.addParts(["tail"]);
    releasePreparation();
    for (let elapsed = 0; elapsed < 200; elapsed++) {
      await vi.advanceTimersByTimeAsync(1);
      if ((await savedParts()).includes("first")) break;
    }
    expect(await savedParts()).toEqual(["first"]);

    // The first batch has now reset the window, so the tail is not due yet.
    await vi.advanceTimersByTimeAsync(50);
    expect(await savedParts()).toEqual(["first"]);

    // It still has to arrive once the window it was re-armed against elapses,
    // otherwise holding it back would pass this test by never publishing.
    await vi.advanceTimersByTimeAsync(100);
    expect(await savedParts()).toEqual(["first", "tail"]);
  });
});

test("holds its deltas until what it waits on settles, then flushes them, even when that fails", async () => {
  const t = initConvexTest();
  await t.action(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, {});
    const streamer = new DeltaStreamer<string>(
      components.agent,
      ctx,
      {
        throttleMs: 100,
        compress: null,
        abortSignal: undefined,
        onAsyncAbort: async () => {},
        materialize: async (parts) => ({ parts, fileRefs: [] }),
      },
      { threadId, order: 0, stepOrder: 0, format: undefined },
    );
    const streamId = await streamer.getStreamId();
    const savedParts = async () => {
      const deltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [{ streamId, cursor: 0 }],
      });
      return deltas.flatMap((delta) => delta.parts);
    };
    const settled = async (parts: string[]) => {
      for (let elapsed = 0; elapsed < 300; elapsed++) {
        await vi.advanceTimersByTimeAsync(1);
        if ((await savedParts()).length === parts.length) break;
      }
      expect(await savedParts()).toEqual(parts);
    };

    let fail!: (error: Error) => void;
    const failing = streamer
      .hold(new Promise((_, reject) => (fail = reject)))
      .catch(() => {});
    await streamer.addParts(["first"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(await savedParts()).toEqual([]);
    fail(new Error("Value is too large"));
    await failing;
    await settled(["first"]);

    let pass!: () => void;
    const passing = streamer.hold(new Promise<void>((r) => (pass = r)));
    await streamer.addParts(["second"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(await savedParts()).toEqual(["first"]);
    pass();
    await passing;
    await settled(["first", "second"]);
    await streamer.finish();
  });
});
