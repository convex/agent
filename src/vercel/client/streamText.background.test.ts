// @vitest-environment node
import process from "node:process";
import { setImmediate } from "node:timers/promises";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { getFunctionAddress } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { Agent, createThread } from "../index.js";
import { mockModel } from "./mockModel.js";
import { components, initConvexTest } from "./setup.test.js";

describe("streamText background consumption", () => {
  test("preserves provider errors for the early-return caller", async () => {
    const t = initConvexTest();
    const providerFailure = "Mock provider failure";
    const onError = vi.fn();
    const agent = new Agent(components.agent, {
      name: "provider-error-test",
      languageModel: mockModel({
        content: [{ type: "text", text: "Partial response" }],
        fail: { error: providerFailure },
      }),
    });
    await t.action(async (ctx) => {
      const threadId = await createThread(ctx, components.agent);
      const result = await agent.streamText(
        ctx,
        { threadId },
        { prompt: "Test", onError },
        { saveStreamDeltas: { returnImmediately: true, throttleMs: 0 } },
      );
      const errors = [];
      for await (const part of result.fullStream) {
        if (part.type === "error") errors.push(part.error);
      }
      await setImmediate();
      expect(errors).toEqual([providerFailure]);
      expect(onError).toHaveBeenCalledExactlyOnceWith({
        error: providerFailure,
      });
      const streams = await ctx.runQuery(components.agent.streams.list, {
        threadId,
        statuses: ["streaming", "finished", "aborted"],
      });
      expect(streams).toHaveLength(1);
      expect(streams[0].status).toBe("aborted");
      const messages = await agent.listMessages(ctx, {
        threadId,
        paginationOpts: { cursor: null, numItems: 50 },
      });
      expect(messages.page.some((m) => m.status === "pending")).toBe(false);
    });
  });

  test.each([true, false])(
    "handles abort cleanup failure with returnImmediately=%s",
    async (returnImmediately) => {
      const t = initConvexTest();
      const abort = new AbortController();
      const failure = new Error("Stream abort persistence failed");
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => unhandled.push(error);
      // Keep Vitest's own rejection listener installed as well.
      process.on("unhandledRejection", onUnhandled);
      const logError = vi.spyOn(console, "error").mockImplementation(() => {});
      const onAbort = vi.fn();
      const onConsumptionError = vi.fn();
      let abortFailures = 0;
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
              if (address.reference === abortRef.reference) {
                abortFailures += 1;
                throw failure;
              }
              const result = await ctx.runMutation(reference, args);
              if (address.reference === deltaRef.reference) {
                firstDeltaWritten();
              }
              return result;
            }) as typeof ctx.runMutation,
          };
          const streaming = agent.streamText(
            failingCtx,
            { threadId },
            { prompt: "Test", abortSignal: abort.signal, onAbort },
            {
              saveStreamDeltas: {
                returnImmediately,
                chunking: "word",
                throttleMs: 0,
              },
            },
          );
          // Install the caller's handler before triggering a rejection.
          const consumed = returnImmediately
            ? streaming.then((result) =>
                result.consumeStream({ onError: onConsumptionError }),
              )
            : expect(streaming).rejects.toBe(failure);
          await firstDelta;
          abort.abort(new Error("Caller cancelled"));
          await consumed;

          // Consumption joins onAbort, including its durable cleanup. Drain
          // Node's rejection turn so an orphaned background promise is visible.
          await setImmediate();
          expect(abortFailures).toBe(1);
          expect(onAbort).toHaveBeenCalledOnce();
          expect(unhandled).toEqual([]);
          if (returnImmediately) {
            // The provider-facing consumer does not report this separate
            // background cleanup failure, so streamText must observe it.
            expect(onConsumptionError).not.toHaveBeenCalled();
            expect(logError).toHaveBeenCalledWith(
              "Failed to persist stream deltas:",
              failure,
            );
          } else {
            expect(logError).not.toHaveBeenCalled();
          }
          const messages = await agent.listMessages(ctx, {
            threadId,
            paginationOpts: { cursor: null, numItems: 50 },
          });
          expect(messages.page.some((m) => m.status === "pending")).toBe(false);
        });
      } finally {
        abort.abort();
        logError.mockRestore();
        process.removeListener("unhandledRejection", onUnhandled);
      }
    },
  );
});
