import { expect, test } from "vitest";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { Agent, createThread, saveMessage } from "../index.js";
import type { MessageDoc } from "../../validators.js";
import { components, initConvexTest } from "./setup.test.js";
import { mockModel } from "./mockModel.js";
import { MAX_MATERIALIZATION_STREAMS } from "../../component/streams.js";
import type { ActionCtx } from "./types.js";

const ANSWER: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "Retried." },
];
const END: LanguageModelV4StreamPart[] = [
  { type: "text-end", id: "t" },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
  },
];

// Streams `parts`, then `rest` once `held` resolves, unless the call aborts.
function model(
  parts: LanguageModelV4StreamPart[],
  rest: LanguageModelV4StreamPart[] = [],
  held?: Promise<void>,
) {
  return mockModel({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        async start(controller) {
          for (const part of parts) controller.enqueue(part);
          try {
            await Promise.race([
              held,
              new Promise((_, reject) =>
                abortSignal?.addEventListener("abort", reject),
              ),
            ]);
            for (const part of rest) controller.enqueue(part);
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      }),
    }),
  });
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

// Text is written as it arrives, not held back to a word boundary.
const deltas = {
  saveStreamDeltas: { throttleMs: 0, chunking: (b: string) => b || null },
};

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
  const streamingText = async () => {
    for (const stream of await streams()) {
      if (stream.status !== "streaming") continue;
      const page = await ctx.runQuery(components.agent.streams.listDeltas, {
        threadId,
        cursors: [{ streamId: stream.streamId, cursor: 0 }],
      });
      const parts = page.flatMap((d) => d.parts as { type: string }[]);
      if (parts.some((p) => p.type === "text-delta")) return true;
    }
    return false;
  };
  return { threadId, promptMessageId, rows, streams, streamingText };
}

test("a retry ends the stream of the attempt it replaces, which keeps its text (#432)", async () => {
  await initConvexTest().action(async (ctx) => {
    const s = await promptThread(ctx);
    const release = gate();
    const agent = new Agent(components.agent, {
      name: "lifecycle",
      languageModel: model(ANSWER, END),
    });
    const args = { promptMessageId: s.promptMessageId };
    const first = agent
      .streamText(
        ctx,
        { threadId: s.threadId },
        { ...args, model: model(ANSWER, END, release.opened) },
        deltas,
      )
      .then((result) => result.consumeStream());
    first.catch(() => {});
    await until(s.streamingText);
    await (
      await agent.streamText(ctx, { threadId: s.threadId }, args, deltas)
    ).consumeStream();
    expect((await s.streams()).map((st) => st.status)).toEqual([
      "finished",
      "aborted",
    ]);
    expect((await s.rows()).find((m) => m.status === "failed")).toMatchObject({
      error: "Restarting",
      text: "Retried.",
    });
    release.open();
    await expect(first).rejects.toThrow("Restarting");
  });
});

test("a stopped generation keeps its streamed text after many earlier attempts", async () => {
  await initConvexTest().action(async (ctx) => {
    const s = await promptThread(ctx);
    const agent = new Agent(components.agent, {
      name: "lifecycle",
      languageModel: model(ANSWER, END),
    });
    const args = { promptMessageId: s.promptMessageId };
    for (let i = 0; i < MAX_MATERIALIZATION_STREAMS; i++) {
      await (
        await agent.streamText(ctx, { threadId: s.threadId }, args, deltas)
      ).consumeStream();
    }
    const stop = new AbortController();
    const stopped = agent
      .streamText(
        ctx,
        { threadId: s.threadId },
        {
          ...args,
          model: model(ANSWER, END, new Promise(() => {})),
          abortSignal: stop.signal,
        },
        deltas,
      )
      .catch(() => {});
    await until(s.streamingText);
    stop.abort("Stopped");
    await stopped;
    await until(async () => (await s.rows()).at(-1)?.status !== "pending");
    expect((await s.rows()).at(-1)).toMatchObject({
      status: "failed",
      text: "Retried.",
    });
  });
});

test("finalizeMessage failing a streamed attempt's pending message ends its stream, and the attempt's later save is dropped", async () => {
  await initConvexTest().action(async (ctx) => {
    const s = await promptThread(ctx);
    const release = gate();
    const agent = new Agent(components.agent, {
      name: "lifecycle",
      languageModel: model(ANSWER, END, release.opened),
    });
    const running = agent
      .streamText(
        ctx,
        { threadId: s.threadId },
        { promptMessageId: s.promptMessageId },
        deltas,
      )
      .then((result) => result.consumeStream());
    running.catch(() => {});
    await until(s.streamingText);
    const pending = (await s.rows()).find((m) => m.status === "pending")!;
    // What an app's stop button does.
    await agent.finalizeMessage(ctx, {
      messageId: pending._id,
      result: { status: "failed", error: "Stopped" },
    });
    expect((await s.streams()).map((st) => st.status)).toEqual(["aborted"]);
    release.open();
    await expect(running).rejects.toThrow("Stopped");
    expect((await s.rows()).map((m) => [m.status, m.text])).toEqual([
      ["success", "Go."],
      ["failed", "Retried."],
    ]);
    expect((await s.streams()).map((st) => st.status)).toEqual(["aborted"]);
  });
});
