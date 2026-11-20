import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AsyncIterableStream } from "ai";
import { getFunctionAddress } from "convex/server";
import { createThread } from "../../client/threads.js";
import type { ActionCtx, MutationCtx } from "../../client/types.js";
import { components, initConvexTest } from "./setup.test.js";
import { DeltaStreamer } from "./streaming.js";

const MINUTE = 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

async function recordedStreamer(
  ctx: ActionCtx | MutationCtx,
  { failedHeartbeats = 0 } = {},
) {
  const threadId = await createThread(ctx, components.agent, {});
  const calls: string[] = [];
  const heartbeats: number[] = [];
  const runMutation = (async (reference, args) => {
    const name = getFunctionAddress(reference).reference!.split("/").at(-1)!;
    calls.push(name);
    if (name === "heartbeat") {
      heartbeats.push(Date.now());
      if (heartbeats.length <= failedHeartbeats) {
        throw new Error("heartbeat failed");
      }
    }
    return ctx.runMutation(reference, args);
  }) as ActionCtx["runMutation"];
  const onAsyncAbort = vi.fn(async (_reason: string) => {});
  const streamer = new DeltaStreamer<string>(
    components.agent,
    { ...ctx, runMutation } as ActionCtx | MutationCtx,
    {
      throttleMs: 0,
      abortSignal: undefined,
      compress: null,
      onAsyncAbort,
      finishHandledExternally: true,
    },
    { threadId, order: 0, stepOrder: 0, format: undefined },
  );
  return { streamer, calls, heartbeats, onAsyncAbort };
}

test("a quiet stream heartbeats every 5 minutes and outlives the stream timeout", async () => {
  await initConvexTest().action(async (ctx) => {
    const { streamer, calls, onAsyncAbort } = await recordedStreamer(ctx);
    await streamer.addParts(["before a long tool call"]);
    await vi.advanceTimersByTimeAsync(12 * MINUTE);
    await streamer.addParts(["after it"]);
    await streamer.finish();
    expect(onAsyncAbort).not.toHaveBeenCalled();
    expect(calls).toEqual([
      "create",
      "addDelta",
      "heartbeat",
      "heartbeat",
      "addDelta",
      "finish",
    ]);
  });
});

test("a stream whose deltas keep flowing never heartbeats", async () => {
  await initConvexTest().action(async (ctx) => {
    const { streamer, calls } = await recordedStreamer(ctx);
    for (let i = 0; i < 20; i++) {
      await streamer.addParts([`part ${i}`]);
      await vi.advanceTimersByTimeAsync(MINUTE);
    }
    await streamer.finish();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(calls).toEqual([
      "create",
      ...Array<string>(20).fill("addDelta"),
      "finish",
    ]);
  });
});

test("failed heartbeats retry after 15, 30 and 60 seconds, before the stream times out", async () => {
  await initConvexTest().action(async (ctx) => {
    const { streamer, heartbeats, onAsyncAbort } = await recordedStreamer(ctx, {
      failedHeartbeats: 3,
    });
    await streamer.addParts(["first"]);
    // The latest write that doesn't reschedule the timeout: the worst case.
    await vi.advanceTimersByTimeAsync(2.5 * MINUTE - 1000);
    await streamer.addParts(["late"]);
    const lastWrite = Date.now();
    await vi.advanceTimersByTimeAsync(12 * MINUTE);
    await streamer.addParts(["after"]);
    await streamer.finish();
    expect(onAsyncAbort).not.toHaveBeenCalled();
    expect(heartbeats.map((at) => (at - lastWrite) / 1000)).toEqual([
      300, 315, 345, 405, 705,
    ]);
  });
});

test.each([
  { end: "finish", stop: (s: DeltaStreamer<string>) => s.finish() },
  { end: "fail", stop: (s: DeltaStreamer<string>) => s.fail("stopped") },
  {
    end: "flushAndStopAccepting",
    stop: (s: DeltaStreamer<string>) => s.flushAndStopAccepting(),
  },
  {
    end: "consumeStream",
    stop: (s: DeltaStreamer<string>) =>
      s.consumeStream(
        new ReadableStream<string>({
          start: (controller) => controller.close(),
        }) as AsyncIterableStream<string>,
      ),
  },
])("$end stops the heartbeat mid-retry and mid-write", async ({ stop }) => {
  await initConvexTest().action(async (ctx) => {
    const { streamer, heartbeats } = await recordedStreamer(ctx, {
      failedHeartbeats: Infinity,
    });
    await streamer.addParts(["part"]);
    await vi.advanceTimersByTimeAsync(5 * MINUTE + 5000);
    expect(heartbeats).toHaveLength(1);
    await streamer.addParts(["tail"]);
    await stop(streamer);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(heartbeats).toHaveLength(1);
  });
});

test("a stream written from a mutation never heartbeats", async () => {
  await initConvexTest().mutation(async (ctx) => {
    const { streamer, calls } = await recordedStreamer(ctx);
    await streamer.addParts(["part"]);
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    await streamer.finish();
    expect(calls).toEqual(["create", "addDelta", "finish"]);
  });
});
