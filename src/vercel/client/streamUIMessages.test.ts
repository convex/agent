import { describe, expect, expectTypeOf, test } from "vitest";
import type { FunctionReference, RegisteredQuery } from "convex/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { app, components } from "./setup.test.js";
import { createThread, saveMessages } from "../index.js";
import { listUIMessages } from "./messages.js";
import {
  DeltaStreamer,
  syncStreams,
  vStreamUIMessagesReturnValue,
} from "./streaming.js";
import { vStreamArgs } from "../../validators.js";
import type { StreamQuery } from "../react/types.js";
import type { UIMessagesQuery } from "../react/useUIMessages.js";

// The streaming query the docs describe, with the `returns` validator Convex
// asks every function for. vStreamMessagesReturnValue describes MessageDocs,
// so pairing it with listUIMessages failed to compile (TS2719).
const listThreadMessages = app.query({
  args: {
    threadId: v.string(),
    paginationOpts: paginationOptsValidator,
    streamArgs: vStreamArgs,
  },
  returns: vStreamUIMessagesReturnValue,
  handler: async (ctx, args) => {
    const paginated = await listUIMessages(ctx, components.agent, args);
    const streams = await syncStreams(ctx, components.agent, args);
    return { ...paginated, streams };
  },
});

type Returns =
  typeof listThreadMessages extends RegisteredQuery<
    "public",
    infer _Args,
    infer R
  >
    ? Awaited<R>
    : never;
type ListThreadMessages = FunctionReference<
  "query",
  "public",
  typeof listThreadMessages extends RegisteredQuery<"public", infer A, unknown>
    ? A
    : never,
  Returns
>;
expectTypeOf<ListThreadMessages>().toExtend<UIMessagesQuery>();
expectTypeOf<ListThreadMessages>().toExtend<StreamQuery>();

const { api, createTest } = app.defineModules({
  streamUIMessages: { listThreadMessages },
});

describe("vStreamUIMessagesReturnValue", () => {
  test("accepts every kind of message listUIMessages returns, and its streams", async () => {
    const t = createTest();
    const threadId = await t.run((ctx) =>
      createThread(ctx, components.agent, {}),
    );
    const streamId = await t.run(async (ctx) => {
      await saveMessages(ctx, components.agent, {
        threadId,
        messages: [
          { role: "system", content: "Be brief." },
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              {
                type: "file",
                data: new URL("https://example.com/a.png"),
                mediaType: "image/png",
              },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "Look it up." },
              { type: "text", text: "Checking" },
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "lookup",
                input: { q: "a.png" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "lookup",
                output: { type: "text", value: "a cat" },
              },
            ],
          },
          { role: "assistant", content: "A cat." },
        ],
        metadata: [{}, {}, {}, {}, { error: "late", status: "failed" }],
      });
      const streamer = new DeltaStreamer(
        components.agent,
        ctx,
        {
          throttleMs: 0,
          abortSignal: undefined,
          compress: null,
          onAsyncAbort: async () => {},
        },
        { threadId, order: 5, stepOrder: 0, format: "UIMessageChunk" },
      );
      await streamer.addParts([
        { type: "text-delta", id: "t1", delta: "Once upon a time" },
      ]);
      return streamer.streamId!;
    });

    const paginationOpts = { numItems: 10, cursor: null };
    const listed = await t.query(api.streamUIMessages.listThreadMessages, {
      threadId,
      paginationOpts,
      streamArgs: { kind: "list" },
    });
    expect(listed.page.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    expect(listed.streams).toMatchObject({ kind: "list" });

    const deltas = await t.query(api.streamUIMessages.listThreadMessages, {
      threadId,
      paginationOpts,
      streamArgs: { kind: "deltas", cursors: [{ streamId, cursor: 0 }] },
    });
    expect(deltas.streams).toMatchObject({ kind: "deltas" });
  });
});
