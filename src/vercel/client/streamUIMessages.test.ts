import { describe, expect, expectTypeOf, test } from "vitest";
import { paginationOptsValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import { app, components } from "./setup.test.js";
import {
  createThread,
  DeltaStreamer,
  listMessages,
  listUIMessages,
  saveMessages,
  syncStreams,
  vStreamArgs,
  vStreamUIMessagesReturnValue,
  type UIMessage,
} from "../index.js";
import type { StreamQuery } from "../react/types.js";
import {
  useUIMessages,
  type UIMessagesQuery,
  type UIMessagesQueryResult,
} from "../react/useUIMessages.js";

// The streaming query from docs/streaming.mdx.
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

// The non-streaming query from docs/messages.mdx.
const listThreadUIMessages = app.query({
  args: { threadId: v.string(), paginationOpts: paginationOptsValidator },
  returns: vStreamUIMessagesReturnValue,
  handler: async (ctx, args) => {
    return await listUIMessages(ctx, components.agent, args);
  },
});

const listThreadMessageDocs = app.query({
  args: { threadId: v.string(), paginationOpts: paginationOptsValidator },
  returns: vStreamUIMessagesReturnValue,
  handler: async (ctx, args) => {
    const paginated = await listMessages(ctx, components.agent, args);
    return paginated as unknown as Infer<typeof vStreamUIMessagesReturnValue>;
  },
});

const { api, createTest } = app.defineModules({
  streamUIMessages: {
    listThreadMessages,
    listThreadUIMessages,
    listThreadMessageDocs,
  },
});

type ListThreadMessages = typeof api.streamUIMessages.listThreadMessages;
expectTypeOf<ListThreadMessages>().toExtend<UIMessagesQuery>();
expectTypeOf<ListThreadMessages>().toExtend<StreamQuery>();
expectTypeOf<
  typeof api.streamUIMessages.listThreadUIMessages
>().toExtend<UIMessagesQuery>();

type Results = ReturnType<
  typeof useUIMessages<ListThreadMessages>
>["results"][number];
expectTypeOf<Results["parts"]>().toEqualTypeOf<UIMessage["parts"]>();
expectTypeOf<Results["metadata"]>().toEqualTypeOf<UIMessage["metadata"]>();

type Validated = Infer<typeof vStreamUIMessagesReturnValue>;
type ValidatedQuery = UIMessagesQuery<unknown, Validated["page"][number]>;
type ValidatedMessage = UIMessagesQueryResult<ValidatedQuery>;
expectTypeOf<ValidatedMessage>().toEqualTypeOf<UIMessage>();
expectTypeOf<ValidatedMessage["parts"]>().toEqualTypeOf<UIMessage["parts"]>();
expectTypeOf<ValidatedMessage["metadata"]>().toEqualTypeOf<
  UIMessage["metadata"]
>();
expectTypeOf<
  keyof Infer<typeof vStreamUIMessagesReturnValue.fields.page.element>
>().toEqualTypeOf<keyof UIMessage>();

describe("vStreamUIMessagesReturnValue", () => {
  test("accepts what listUIMessages and syncStreams return", async () => {
    const t = createTest();
    const threadId = await t.run((ctx) =>
      createThread(ctx, components.agent, {}),
    );
    const streamId = await t.run(async (ctx) => {
      await saveMessages(ctx, components.agent, {
        threadId,
        agentName: "helper",
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
      await streamer.flushAndStopAccepting();
      return streamer.streamId!;
    });

    const paginationOpts = { numItems: 10, cursor: null };
    const pageRoles = ["system", "user", "assistant"];

    const listed = await t.query(api.streamUIMessages.listThreadMessages, {
      threadId,
      paginationOpts,
      streamArgs: { kind: "list" },
    });
    expect(listed.page.map((m) => m.role)).toEqual(pageRoles);
    expect(listed.page.at(-1)).toMatchObject({
      status: "failed",
      agentName: "helper",
    });
    expect(listed.streams).toMatchObject({
      kind: "list",
      messages: [{ streamId }],
    });

    const deltas = await t.query(api.streamUIMessages.listThreadMessages, {
      threadId,
      paginationOpts,
      streamArgs: { kind: "deltas", cursors: [{ streamId, cursor: 0 }] },
    });
    expect(deltas.streams).toMatchObject({
      kind: "deltas",
      deltas: [{ streamId }],
    });

    const noStreamArgs = await t.query(
      api.streamUIMessages.listThreadMessages,
      { threadId, paginationOpts },
    );
    expect(noStreamArgs.page.map((m) => m.role)).toEqual(pageRoles);
    expect(noStreamArgs.streams).toBeUndefined();

    const nonStreaming = await t.query(
      api.streamUIMessages.listThreadUIMessages,
      { threadId, paginationOpts },
    );
    expect(nonStreaming.page.map((m) => m.role)).toEqual(pageRoles);
  });

  test("rejects a page of MessageDocs", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) => {
      const threadId = await createThread(ctx, components.agent, {});
      await saveMessages(ctx, components.agent, {
        threadId,
        messages: [{ role: "user", content: "Hi" }],
      });
      return threadId;
    });
    await expect(
      t.query(api.streamUIMessages.listThreadMessageDocs, {
        threadId,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(/Validator error/);
  });
});
