import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { stepCountIs } from "ai";
import { Agent, createTool, createThread } from "../index.js";
import { v } from "convex/values";
import { getFunctionAddress, type FunctionReference } from "convex/server";
import type { ActionCtx } from "../../client/types.js";
import { app, components } from "./setup.test.js";
import { mockModel } from "./mockModel.js";
import { DeltaStreamer } from "./streaming.js";

const MINUTE = 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

// Default-runtime actions can run for 30 minutes, longer than the 10 minute
// stream timeout, so a live action can go that long without a delta.
const slowTool = createTool({
  description: "slow",
  inputSchema: z.object({}),
  execute: async () => {
    await new Promise((resolve) => setTimeout(resolve, 12 * MINUTE));
    return "slow result";
  },
});

const twelveMinuteTool = new Agent(components.agent, {
  name: "long-tool",
  languageModel: mockModel({
    contentSteps: [
      [
        {
          type: "tool-call",
          toolCallId: "t1",
          toolName: "slowTool",
          input: "{}",
        },
      ],
      [{ type: "text", text: "the answer" }],
    ],
  }),
  tools: { slowTool },
});

const run = app.action({
  args: { threadId: v.string(), returnImmediately: v.boolean() },
  handler: async (ctx, { threadId, returnImmediately }) => {
    const result = await twelveMinuteTool.streamText(
      ctx,
      { threadId },
      { prompt: "go", stopWhen: stepCountIs(3) },
      { saveStreamDeltas: { returnImmediately } },
    );
    await result.consumeStream();
  },
});

const { api, createTest } = app.defineModules({ longTool: { run } });

describe("a live action whose tool runs past the stream timeout", () => {
  test.each([{ returnImmediately: false }, { returnImmediately: true }])(
    "keeps its stream and saves its answer (returnImmediately: $returnImmediately)",
    async ({ returnImmediately }) => {
      vi.useFakeTimers();
      const t = createTest();
      const threadId = await t.run((ctx) =>
        createThread(ctx, components.agent, {}),
      );

      let settled = false;
      const outcome = t
        .action(api.longTool.run, { threadId, returnImmediately })
        .then(
          () => "returned",
          (error: unknown) => String(error),
        )
        .finally(() => {
          settled = true;
        });
      // Fake timers fire from the code that advances them, and the action's
      // timers call ctx.runMutation, so advance from inside a test function.
      await t.action(async () => {
        for (let i = 0; !settled && i < 20 * 60; i++) {
          await vi.advanceTimersByTimeAsync(1000);
        }
      });
      expect(await outcome).toBe("returned");
      await t.finishInProgressScheduledFunctions();

      const { page } = await t.run((ctx) =>
        ctx.runQuery(components.agent.messages.listMessagesByThreadId, {
          threadId,
          order: "asc",
          paginationOpts: { cursor: null, numItems: 10 },
        }),
      );
      expect(page.filter((m) => m.status !== "success")).toEqual([]);
      expect(page.at(-1)).toMatchObject({
        status: "success",
        text: "the answer",
      });
      const streams = await t.run((ctx) =>
        ctx.runQuery(components.agent.streams.list, {
          threadId,
          statuses: ["streaming", "finished", "aborted"],
        }),
      );
      expect(streams.map((s) => s.status)).toEqual(["finished"]);
    },
    60_000,
  );
});

describe("the DeltaStreamer keepalive", () => {
  function recordingStreamer({ inAction = true, failedHeartbeats = 0 } = {}) {
    const calls: string[] = [];
    const heartbeatTimes: number[] = [];
    // The component's rule: a write or heartbeat reschedules the 10 minute
    // timeout once 2.5 minutes have passed since it last did.
    let rescheduledAt = Date.now();
    const reschedule = () => {
      if (Date.now() - rescheduledAt >= 2.5 * MINUTE)
        rescheduledAt = Date.now();
    };
    const runMutation = async (ref: FunctionReference<"mutation">) => {
      const name = getFunctionAddress(ref).reference!.split("/").at(-1)!;
      calls.push(name);
      if (name === "create") rescheduledAt = Date.now();
      if (name === "heartbeat") {
        heartbeatTimes.push(Date.now());
        if (heartbeatTimes.length <= failedHeartbeats) {
          throw new Error("heartbeat failed");
        }
      }
      if (name === "addDelta" || name === "heartbeat") reschedule();
      return name === "create" ? "stream-1" : name === "addDelta" ? true : null;
    };
    const timedOut = () => Date.now() - rescheduledAt >= 10 * MINUTE;
    const streamer = new DeltaStreamer<string>(
      components.agent,
      (inAction
        ? { runMutation, runAction: vi.fn() }
        : { runMutation }) as unknown as ActionCtx,
      {
        throttleMs: 0,
        abortSignal: undefined,
        compress: null,
        onAsyncAbort: async () => {},
      },
      { threadId: "thread-1", order: 0, stepOrder: 0, format: undefined },
    );
    const heartbeats = () => calls.filter((c) => c === "heartbeat").length;
    return { calls, streamer, heartbeats, heartbeatTimes, timedOut };
  }

  // The worst case: the last write lands just before it would reschedule, so
  // the keepalive fires 7.5 minutes after the timeout was last rescheduled.
  async function quietAfterLateWrite(streamer: DeltaStreamer<string>) {
    await streamer.addParts(["first"]);
    await vi.advanceTimersByTimeAsync(2.5 * MINUTE - 1000);
    await streamer.addParts(["late"]);
    return Date.now();
  }

  test("a failed heartbeat is retried before a live stream times out", async () => {
    vi.useFakeTimers();
    const { streamer, timedOut, heartbeats } = recordingStreamer({
      failedHeartbeats: 1,
    });
    await quietAfterLateWrite(streamer);
    for (let i = 0; i < 20 * 4; i++) {
      await vi.advanceTimersByTimeAsync(MINUTE / 4);
      expect(timedOut()).toBe(false);
    }
    expect(heartbeats()).toBeGreaterThan(1);
    await streamer.finish();
  });

  test("failed heartbeats back off for 15, 30 and 60 seconds, then every 5 minutes", async () => {
    vi.useFakeTimers();
    const { streamer, heartbeatTimes, timedOut } = recordingStreamer({
      failedHeartbeats: 3,
    });
    const lastWrite = await quietAfterLateWrite(streamer);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(
      heartbeatTimes.slice(0, 6).map((t) => (t - lastWrite) / 1000),
    ).toEqual([300, 315, 345, 405, 705, 1005]);
    // The last retry lands 9.25 minutes after the timeout was rescheduled.
    expect(timedOut()).toBe(false);
    await streamer.finish();
    const attempts = heartbeatTimes.length;
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(heartbeatTimes.length).toBe(attempts);
  });

  test("a stream whose deltas keep flowing never heartbeats", async () => {
    vi.useFakeTimers();
    const { calls, streamer } = recordingStreamer();
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

  test("a quiet stream heartbeats every 5 minutes until it finishes", async () => {
    vi.useFakeTimers();
    const { streamer, heartbeats } = recordingStreamer();
    await streamer.addParts(["before the tool"]);
    await vi.advanceTimersByTimeAsync(12 * MINUTE);
    expect(heartbeats()).toBe(2);

    await streamer.addParts(["after the tool"]);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(heartbeats()).toBe(2);
    await streamer.finish();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(heartbeats()).toBe(2);
  });

  test.each([
    {
      name: "is aborted",
      end: (s: DeltaStreamer<string>) => s.fail("stopped"),
    },
    {
      name: "stops accepting parts for an inline save",
      end: (s: DeltaStreamer<string>) => s.flushAndStopAccepting(),
    },
  ])("a stream that $name stops heartbeating", async ({ end }) => {
    vi.useFakeTimers();
    const { streamer, heartbeats } = recordingStreamer();
    await streamer.addParts(["part"]);
    await end(streamer);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(heartbeats()).toBe(0);
  });

  test.each([
    { name: "finishes", end: (s: DeltaStreamer<string>) => s.finish() },
    { name: "is aborted", end: (s: DeltaStreamer<string>) => s.fail("stop") },
    {
      name: "stops accepting parts",
      end: (s: DeltaStreamer<string>) => s.flushAndStopAccepting(),
    },
  ])(
    "a stream that $name while retrying a heartbeat stops",
    async ({ end }) => {
      vi.useFakeTimers();
      const { streamer, heartbeatTimes } = recordingStreamer({
        failedHeartbeats: Infinity,
      });
      await streamer.addParts(["part"]);
      await vi.advanceTimersByTimeAsync(5 * MINUTE + 5000);
      expect(heartbeatTimes).toHaveLength(1);
      await end(streamer);
      await vi.advanceTimersByTimeAsync(30 * MINUTE);
      expect(heartbeatTimes).toHaveLength(1);
    },
  );

  test("a stream written from a mutation sets no timer", async () => {
    vi.useFakeTimers();
    const { streamer } = recordingStreamer({ inAction: false });
    await streamer.addParts(["part"]);
    expect(vi.getTimerCount()).toBe(0);
    await streamer.finish();
  });
});
