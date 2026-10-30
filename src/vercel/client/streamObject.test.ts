import { expect, test, vi } from "vitest";
import { v } from "convex/values";
import { z } from "zod/v4";
import { Agent } from "../index.js";
import type { MessageDoc } from "../../validators.js";
import { app, components } from "./setup.test.js";
import { mockModel } from "./mockModel.js";

const storage = v.union(
  v.literal("store"),
  v.literal("none"),
  v.literal("noThread"),
);

const run = app.action({
  args: { storage },
  handler: async (ctx, args) => {
    const usage: Array<number | undefined> = [];
    let rawResponses = 0;
    const agent = new Agent(components.agent, {
      name: "stream-object",
      languageModel: mockModel({
        content: [{ type: "text", text: JSON.stringify({ hello: 1 }) }],
      }),
      usageHandler: async (_ctx, { usage: { totalTokens } }) => {
        usage.push(totalTokens);
      },
      rawRequestResponseHandler: async () => {
        rawResponses++;
      },
      ...(args.storage === "none"
        ? { storageOptions: { saveMessages: "none" as const } }
        : {}),
    });
    const threadId =
      args.storage === "noThread"
        ? undefined
        : (await agent.createThread(ctx, {})).threadId;
    const result = await agent.streamObject(
      ctx,
      threadId ? { threadId } : { userId: "user-1" },
      { prompt: "Go.", schema: z.object({ hello: z.string() }) },
    );
    for await (const _ of result.partialObjectStream) {
      // Drain.
    }
    await result.object.catch(() => {});
    // onFinish runs after the object settles.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const messages = threadId
      ? (
          await ctx.runQuery(components.agent.messages.listMessagesByThreadId, {
            threadId,
            order: "asc",
            paginationOpts: { cursor: null, numItems: 10 },
          })
        ).page
      : [];
    return {
      statuses: (messages as MessageDoc[]).map((m) => [
        m.message?.role,
        m.status,
      ]),
      usage,
      rawResponses,
    };
  },
});

const { api, createTest } = app.defineModules({ streamObject: { run } });

test("a streamed object that fails its schema fails its pending message", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const t = createTest();
  const r = await t.action(api.streamObject.run, { storage: "store" });
  expect(r.statuses).toEqual([
    ["user", "success"],
    ["assistant", "failed"],
  ]);
});

test.each(["none", "noThread"] as const)(
  "a streamed object that fails its schema still reports its usage without storage (%s)",
  async (storage) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = createTest();
    const r = await t.action(api.streamObject.run, { storage });
    expect(r.usage).toEqual([13]);
    expect(r.rawResponses).toBe(1);
  },
);
