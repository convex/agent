import { expect, test } from "vitest";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { Agent, createThread, saveMessage } from "../index.js";
import type { MessageDoc } from "../../validators.js";
import { components, initConvexTest } from "./setup.test.js";
import { mockModel } from "./mockModel.js";
import type { ActionCtx } from "./types.js";

async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

async function promptThread(ctx: ActionCtx) {
  const threadId = await createThread(ctx, components.agent, {});
  const { messageId: promptMessageId } = await saveMessage(
    ctx,
    components.agent,
    { threadId, prompt: "Go." },
  );
  const rows = async () =>
    (
      await ctx.runQuery(components.agent.messages.listMessagesByThreadId, {
        threadId,
        order: "asc",
      })
    ).page as MessageDoc[];
  const streams = () =>
    ctx.runQuery(components.agent.streams.list, {
      threadId,
      statuses: ["streaming", "finished", "aborted"],
    });
  return { threadId, promptMessageId, rows, streams };
}

// Paced so the text waits out the delta throttle, with the last word still
// held back by the default chunking when the stream ends.
function endingModel(end: "error" | "throw" | "abort", stop: () => void) {
  const error = new Error("The provider failed");
  return mockModel({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({
            type: "text-delta",
            id: "t",
            delta: "A partial ",
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.enqueue({ type: "text-delta", id: "t", delta: "answer" });
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (end === "abort") {
            stop();
            if (!abortSignal?.aborted) {
              await new Promise((resolve) =>
                abortSignal?.addEventListener("abort", resolve),
              );
            }
            controller.error(new DOMException("Stopped", "AbortError"));
          } else if (end === "throw") {
            controller.error(error);
          } else {
            controller.enqueue({ type: "error", error });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "error", raw: undefined },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            });
            controller.close();
          }
        },
      }),
    }),
  });
}

test.each(["error", "throw", "abort"] as const)(
  "a stream that ends on %s keeps the text its caller saw (#479)",
  async (end) => {
    await initConvexTest().action(async (ctx) => {
      const s = await promptThread(ctx);
      const stop = new AbortController();
      const agent = new Agent(components.agent, {
        name: "lifecycle",
        languageModel: endingModel(end, () => stop.abort("Stopped")),
      });
      let seen = "";
      await agent
        .streamText(
          ctx,
          { threadId: s.threadId },
          {
            promptMessageId: s.promptMessageId,
            abortSignal: stop.signal,
            onChunk: ({ chunk }) => {
              if (chunk.type === "text-delta") seen += chunk.text;
            },
          },
          { saveStreamDeltas: true },
        )
        .then((result) => result.consumeStream())
        .catch(() => {});
      await until(async () => (await s.rows()).at(-1)?.status !== "pending");
      const [stream] = await s.streams();
      const deltas = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId: s.threadId,
        cursors: [{ streamId: stream.streamId, cursor: 0 }],
      });
      const streamed = deltas
        .flatMap((d) => d.parts as { type: string; delta?: string }[])
        .filter((p) => p.type === "text-delta")
        .map((p) => p.delta)
        .join("");
      expect(seen).toMatch(/^A partial /);
      expect(stream.status).toBe("aborted");
      expect(streamed).toBe(seen);
      expect((await s.rows()).at(-1)).toMatchObject({
        status: "failed",
        text: seen,
      });
    });
  },
);
