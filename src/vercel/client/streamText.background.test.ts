// @vitest-environment node
import process from "node:process";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { getFunctionAddress } from "convex/server";
import { expect, test, vi } from "vitest";
import { Agent, createThread } from "../index.js";
import { mockModel } from "./mockModel.js";
import { DeltaStreamer } from "./streaming.js";
import { components, initConvexTest } from "./setup.test.js";

test("returnImmediately observes a failed abort cleanup", async () => {
  const t = initConvexTest();
  const abort = new AbortController();
  const failure = new Error("Stream abort persistence failed");
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  // Keep Vitest's own rejection listener installed as well.
  process.on("unhandledRejection", onUnhandled);
  const logError = vi.spyOn(console, "error").mockImplementation(() => {});
  let firstDeltaWritten!: () => void;
  const firstDelta = new Promise<void>((resolve) => {
    firstDeltaWritten = resolve;
  });
  const abortRef = getFunctionAddress(components.agent.streams.abort);
  const deltaRef = getFunctionAddress(components.agent.streams.addDelta);
  const agent = new Agent(components.agent, {
    name: "background-stream-test",
    languageModel: mockModel({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text" });
            controller.enqueue({
              type: "text-delta",
              id: "text",
              delta: "Partial response ",
            });
            abortSignal?.addEventListener(
              "abort",
              () => controller.error(abortSignal.reason),
              { once: true },
            );
          },
        }),
      }),
    }),
  });

  try {
    await t.action(async (ctx) => {
      const threadId = await createThread(ctx, components.agent);
      const failingCtx = {
        ...ctx,
        runMutation: (async (reference, args) => {
          const address = getFunctionAddress(reference);
          if (address.reference === abortRef.reference) throw failure;
          const result = await ctx.runMutation(reference, args);
          if (address.reference === deltaRef.reference) firstDeltaWritten();
          return result;
        }) as typeof ctx.runMutation,
      };
      const result = await agent.streamText(
        failingCtx,
        { threadId },
        { prompt: "Test", abortSignal: abort.signal },
        {
          saveStreamDeltas: {
            returnImmediately: true,
            chunking: "word",
            throttleMs: 0,
          },
        },
      );
      const consumed = result.consumeStream();
      await firstDelta;
      abort.abort(new Error("Caller cancelled"));
      await consumed;
      // Drain Node's rejection turn so an orphaned promise would be visible.
      await setImmediate();
    });
    expect(unhandled).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      "Failed to persist stream deltas:",
      failure,
    );
  } finally {
    abort.abort();
    logError.mockRestore();
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("a failed background delta write is observed while the source is still open", async () => {
  const t = initConvexTest();
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const abortFailure = new Error("onAsyncAbort failed");
  try {
    await t.action(async (ctx) => {
      const threadId = await createThread(ctx, components.agent);
      const deltaRef = getFunctionAddress(components.agent.streams.addDelta);
      const failingCtx = {
        ...ctx,
        runMutation: (async (reference, args) => {
          if (getFunctionAddress(reference).reference === deltaRef.reference) {
            throw new Error("addDelta failed");
          }
          return ctx.runMutation(reference, args);
        }) as typeof ctx.runMutation,
      };
      const streamer = new DeltaStreamer<string>(
        components.agent,
        failingCtx,
        {
          throttleMs: 0,
          abortSignal: undefined,
          compress: null,
          onAsyncAbort: async () => {
            throw abortFailure;
          },
        },
        {
          threadId,
          order: 0,
          stepOrder: 0,
          format: "UIMessageChunk",
        },
      );
      // The source stays open after the failed write, so nothing awaits the
      // write until it closes.
      const source = new ReadableStream<string>({
        async start(controller) {
          controller.enqueue("a");
          await setTimeout(20);
          controller.close();
        },
      });
      await expect(
        streamer.consumeStream(
          source as Parameters<typeof streamer.consumeStream>[0],
        ),
      ).rejects.toBe(abortFailure);
      await setImmediate();
    });
    expect(unhandled).toEqual([]);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});
