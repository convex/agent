import { expect, test, vi } from "vitest";
import { v } from "convex/values";
import { z } from "zod/v4";
import { streamText as streamTextAi } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { Agent } from "../index.js";
import type { MessageDoc } from "../../validators.js";
import { app, components } from "./setup.test.js";
import { mockModel } from "./mockModel.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Streams part of a reply, then hangs until its signal aborts, as a
// provider's fetch would.
function hangingModel() {
  return mockModel({
    doGenerate: async () => {
      throw new Error("unused");
    },
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: '{"hel' });
          await new Promise<void>((resolve) =>
            abortSignal?.addEventListener("abort", () => resolve()),
          );
          controller.error(
            new DOMException("The operation was aborted", "AbortError"),
          );
        },
      }),
    }),
  });
}

const run = app.action({
  args: { mode: v.union(v.literal("streamObject"), v.literal("start")) },
  handler: async (ctx, args) => {
    const agent = new Agent(components.agent, {
      name: "abort",
      languageModel: hangingModel(),
    });
    const { threadId } = await agent.createThread(ctx, {});
    const abort = new AbortController();
    if (args.mode === "streamObject") {
      const result = await agent.streamObject(
        ctx,
        { threadId },
        {
          prompt: "Go.",
          schema: z.object({ hello: z.string() }),
          abortSignal: abort.signal,
        },
      );
      setTimeout(() => abort.abort("Stopped"), 20);
      try {
        for await (const _ of result.partialObjectStream) {
          // Drain.
        }
      } catch {
        // The abort.
      }
      await result.object.catch(() => {});
    } else {
      // agent.start, then the AI SDK directly.
      const { args: aiArgs } = await agent.start(
        ctx,
        { prompt: "Go.", abortSignal: abort.signal },
        { threadId },
      );
      const result = streamTextAi({ ...(aiArgs as any) });
      setTimeout(() => abort.abort("Stopped"), 20);
      await result.consumeStream();
    }
    await sleep(200);
    const { page } = await ctx.runQuery(
      components.agent.messages.listMessagesByThreadId,
      { threadId, order: "asc" },
    );
    return (page as MessageDoc[]).map((m) => [
      m.message?.role,
      m.status,
      m.error ?? null,
    ]);
  },
});

const { api, createTest } = app.defineModules({ startAbort: { run } });

test.each(["streamObject", "start"] as const)(
  "an abort mid-stream fails the pending message (%s)",
  async (mode) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = createTest();
    const messages = await t.action(api.startAbort.run, { mode });
    expect(messages.map(([role, status]) => [role, status])).toEqual([
      ["user", "success"],
      ["assistant", "failed"],
    ]);
    if (mode === "start") expect(messages[1][2]).toBe("Stopped");
  },
);
