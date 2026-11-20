import { expect, test, vi } from "vitest";
import { v } from "convex/values";
import { z } from "zod/v4";
import { isStepCount, simulateReadableStream } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { Agent, createTool } from "../index.js";
import type { MessageDoc } from "../../validators.js";
import type { ActionCtx } from "./types.js";
import { app, components } from "./setup.test.js";
import { mockModel } from "./mockModel.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const FIRST: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: "tc", toolName: "lookup", input: "{}" },
  {
    type: "finish",
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: USAGE,
  },
];
const SECOND: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "Looked it up" },
  { type: "text-end", id: "t" },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: undefined },
    usage: USAGE,
  },
];

const run = app.action({
  args: {
    deltas: v.boolean(),
    mode: v.union(
      v.literal("abortInTool"),
      v.literal("deltaFails"),
      v.literal("ok"),
    ),
  },
  handler: async (ctx, args) => {
    let calls = 0;
    const abort = new AbortController();
    const agent = new Agent(components.agent, {
      name: "saved",
      languageModel: mockModel({
        doGenerate: async () => {
          throw new Error("unused");
        },
        doStream: async ({ abortSignal }) => {
          abortSignal?.throwIfAborted();
          return {
            stream: simulateReadableStream({
              chunks: calls++ ? SECOND : FIRST,
            }),
          };
        },
      }),
      tools: {
        lookup: createTool({
          inputSchema: z.object({}),
          execute: async () => {
            if (args.mode === "abortInTool") {
              abort.abort("Stopped");
              await sleep(20);
            }
            return { ok: true };
          },
        }),
      },
    });
    const { threadId } = await agent.createThread(ctx, {});
    const intercepted: ActionCtx = {
      ...ctx,
      runMutation: (async (reference, mutationArgs) => {
        if (
          args.mode === "deltaFails" &&
          (mutationArgs as { parts?: { type: string }[] }).parts?.some(
            (p) => p.type === "tool-output-available",
          )
        ) {
          throw new Error("delta failed");
        }
        return ctx.runMutation(reference, mutationArgs);
      }) as ActionCtx["runMutation"],
    };
    let thrown = "none";
    const result = await agent
      .streamText(
        intercepted,
        { threadId },
        {
          prompt: "Go.",
          stopWhen: isStepCount(5),
          abortSignal: abort.signal,
          maxRetries: 0,
        },
        args.deltas
          ? {
              saveStreamDeltas: {
                throttleMs: 0,
                returnImmediately: true,
              },
            }
          : {},
      )
      .catch((e) => {
        thrown = e instanceof Error ? e.message : String(e);
        return undefined;
      });
    const saved = await (
      (result as { saved?: Promise<void> } | undefined)?.saved ??
      Promise.resolve()
    ).then(
      () => "resolved",
      (e) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
    );
    await sleep(50);
    const { page } = await ctx.runQuery(
      components.agent.messages.listMessagesByThreadId,
      { threadId, order: "asc" },
    );
    return {
      thrown,
      saved,
      modelCalls: calls,
      rows: (page as MessageDoc[]).map(
        (m) => `${m.message?.role}:${m.status}:${m.error ?? ""}`,
      ),
    };
  },
});

const { api, createTest } = app.defineModules({ streamTextSaved: { run } });

test.each([
  { deltas: false, mode: "abortInTool" },
  { deltas: true, mode: "abortInTool" },
  { deltas: true, mode: "deltaFails" },
  { deltas: true, mode: "ok" },
] as const)(
  "streamText saved rejects when the generation was aborted or failed ($mode, deltas: $deltas)",
  async (args) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = createTest();
    const result = await t.action(api.streamTextSaved.run, args);
    if (args.mode === "ok") {
      expect(result.saved).toBe("resolved");
    } else {
      expect(result.saved).toMatch(/^rejected/);
      expect(result.rows.at(-1)).toMatch(/^assistant:failed:/);
    }
  },
);
