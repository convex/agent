import { describe, expect, test } from "vitest";
import { getDocumentSize } from "convex/values";
import type {
  LanguageModelV4Content,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  convertToModelMessages,
  generateText,
  type ModelMessage,
  type StepResult,
  type ToolSet,
  readUIMessageStream,
  simulateReadableStream,
  streamText,
  type Citation,
  type ProviderMetadata,
  type UIMessage as AIUIMessage,
} from "ai";
import {
  Agent,
  createThread,
  fromUIMessages,
  listUIMessages,
  toUIMessages,
  type UIMessage,
} from "../index.js";
import { MockLanguageModel } from "./mockModel.js";
import type { ActionCtx, AgentComponent } from "./types.js";
import { serializeResponseMessages } from "../mapping.js";
import { deriveUIMessagesFromDeltas } from "../deltas.js";
import {
  getPersistedUIMessageChunkParts,
  projectPersistedUIMessageChunks,
} from "../../streaming/materializePersistedUIMessageChunks.js";
import { initConvexTest } from "../../component/setup.test.js";
import { api } from "../../component/_generated/api.js";
import type { ComponentApi } from "../../component/_generated/component.js";

// The component runs as the root app here so the test can read stored rows.
const component = api as unknown as ComponentApi;
type T = ReturnType<typeof initConvexTest>;

const PROMPT = "Why is the sky blue?";
const TEXT = "The sky is blue because of Rayleigh scattering.";
const RAW_CITATION = {
  type: "char_location",
  cited_text: "Rayleigh scattering makes the sky blue.",
  document_index: 0,
  document_title: "Sky facts",
  start_char_index: 0,
  end_char_index: 39,
};
const CITATIONS: Citation[] = [
  {
    source: {
      type: "source",
      sourceType: "document",
      id: "0",
      mediaType: "text/plain",
      title: "Sky facts",
      providerMetadata: { anthropic: { ...RAW_CITATION } },
    },
    citedText: "Rayleigh scattering makes the sky blue.",
  },
  {
    source: {
      type: "source",
      sourceType: "url",
      id: "https://example.com/sky",
      url: "https://example.com/sky",
      title: "Sky",
    },
    startIndex: 27,
    endIndex: 46,
    citedText: "Rayleigh scattering",
  },
];
const CITED_METADATA = {
  anthropic: { citations: [RAW_CITATION] },
} satisfies ProviderMetadata;
const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const STOP = { unified: "stop" as const, raw: undefined };
type CitedText = {
  text: string;
  citations?: Citation[];
  providerMetadata?: ProviderMetadata;
};
const CITED: CitedText = {
  text: TEXT,
  citations: CITATIONS,
  providerMetadata: CITED_METADATA,
};
const GRASS: CitedText[] = [{ text: "And grass is green." }];
// The Convex AI Gateway returns Claude Haiku 4.5's web search citations on an
// empty text block ahead of the answer.
const EMPTY_CITED: CitedText[] = [{ ...CITED, text: "" }, { text: TEXT }];
const APPROVAL_TOOL_RESPONSE: ModelMessage = {
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "lookup",
      output: { type: "text", value: "ok" },
    },
  ],
};

/** A model that cites like @ai-sdk/anthropic: on text and on `text-end`. */
function citingModel(texts: CitedText[] = [CITED]) {
  const content: LanguageModelV4Content[] = texts.map((text) => ({
    type: "text",
    ...text,
  }));
  const chunks = (): LanguageModelV4StreamPart[] => [
    { type: "stream-start", warnings: [] },
    ...texts.flatMap(({ text, ...extra }, i): LanguageModelV4StreamPart[] => [
      { type: "text-start", id: `${i}` },
      ...text
        .split(/(?<= )/)
        .filter((delta) => delta.length > 0)
        .map(
          (delta): LanguageModelV4StreamPart => ({
            type: "text-delta",
            id: `${i}`,
            delta,
          }),
        ),
      { type: "text-end", id: `${i}`, ...extra },
    ]),
    { type: "finish", finishReason: STOP, usage: USAGE },
  ];
  return new MockLanguageModel({
    doGenerate: async () => ({
      content,
      finishReason: STOP,
      usage: USAGE,
      warnings: [],
    }),
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: chunks() }),
    }),
  });
}

const agentWith = (languageModel: MockLanguageModel) =>
  new Agent(component, { name: "citations", languageModel });

/** What the AI SDK's own UI message stream ends with for the same model. */
async function sdkUIMessage(model = citingModel()): Promise<AIUIMessage> {
  const result = streamText({ model, prompt: PROMPT });
  let last: AIUIMessage | undefined;
  for await (const message of readUIMessageStream({
    stream: result.toUIMessageStream(),
  })) {
    last = message;
  }
  return last!;
}

function textParts(parts: readonly unknown[]) {
  return (parts as Array<Record<string, unknown>>)
    .filter((part) => part.type === "text")
    .map(({ type, text, state, citations }) => ({
      type,
      text,
      state,
      citations,
    }));
}

type How = "generateText" | "streamText";
const HOWS: How[] = ["generateText", "streamText"];

async function generate(
  t: T,
  how: How,
  model = citingModel(),
  threadId?: string,
  prompt = PROMPT,
) {
  return t.action(async (ctx) => {
    threadId ??= await createThread(ctx, component, {});
    const agent = agentWith(model);
    if (how === "generateText") {
      await agent.generateText(ctx, { threadId }, { prompt });
    } else {
      const result = await agent.streamText(
        ctx,
        { threadId },
        { prompt },
        { saveStreamDeltas: { chunking: "word", throttleMs: 0 } },
      );
      await result.consumeStream();
    }
    return threadId;
  });
}

async function storedAssistants(t: T, threadId: string) {
  const { page } = await t.run((ctx) =>
    ctx.runQuery(component.messages.listMessagesByThreadId, {
      threadId,
      order: "asc",
      paginationOpts: { cursor: null, numItems: 10 },
    }),
  );
  return page.filter((doc) => doc.message?.role === "assistant");
}

async function streamed(t: T, threadId: string) {
  return t.run(async (ctx) => {
    const streams = await ctx.runQuery(component.streams.list, {
      threadId,
      statuses: ["streaming", "finished", "aborted"],
    });
    const deltas = await ctx.runQuery(component.streams.listDeltas, {
      threadId,
      cursors: streams.map(({ streamId }) => ({ streamId, cursor: 0 })),
    });
    return { streams, deltas };
  });
}

describe("text citations", () => {
  test("streamed deltas render the citations the SDK's stream does", async () => {
    const t = initConvexTest();
    const threadId = await generate(t, "streamText");
    const { streams, deltas } = await streamed(t, threadId);
    expect(streams).toHaveLength(1);
    const [message] = await deriveUIMessagesFromDeltas(
      threadId,
      streams,
      deltas,
    );
    const sdk = await sdkUIMessage();
    expect(textParts(sdk.parts)).toMatchObject([{ citations: CITATIONS }]);
    expect(textParts(message.parts)).toEqual(textParts(sdk.parts));
  });

  test("a stream materialized from its deltas keeps the citations", async () => {
    const t = initConvexTest();
    const threadId = await generate(t, "streamText");
    const { streams, deltas } = await streamed(t, threadId);
    const { parts } = getPersistedUIMessageChunkParts(deltas);
    const [projected] = projectPersistedUIMessageChunks(streams[0], parts, {
      status: "failed",
      error: "aborted",
    });
    expect(projected.message).toEqual({
      role: "assistant",
      content: [
        {
          type: "text",
          text: TEXT,
          citations: CITATIONS,
          providerOptions: CITED_METADATA,
        },
      ],
    });
  });

  test.each(HOWS)("%s stores the citations on the text part", async (how) => {
    const t = initConvexTest();
    const threadId = await generate(t, how);
    const [assistant] = await storedAssistants(t, threadId);
    expect(assistant.message!.content).toEqual([
      {
        type: "text",
        text: TEXT,
        citations: CITATIONS,
        providerOptions: CITED_METADATA,
      },
    ]);
  });

  test.each(HOWS)(
    "%s reloads with the citations the SDK's stream renders",
    async (how) => {
      const t = initConvexTest();
      const threadId = await generate(t, how);
      const { page } = await t.run((ctx) =>
        listUIMessages(ctx, component, {
          threadId,
          paginationOpts: { cursor: null, numItems: 10 },
        }),
      );
      const assistant = page.find((m) => m.role === "assistant")!;
      expect(textParts(assistant.parts)).toEqual(
        textParts((await sdkUIMessage()).parts),
      );
    },
  );

  test.each(HOWS)(
    "%s sends the next call the assistant text the SDK sends",
    async (how) => {
      const t = initConvexTest();
      const threadId = await generate(t, how);
      const next = citingModel(GRASS);
      await generate(t, "generateText", next, threadId, "And grass?");
      const sdkNext = citingModel(GRASS);
      await generateText({
        model: sdkNext,
        messages: [
          { role: "user", content: PROMPT },
          ...(await convertToModelMessages([await sdkUIMessage()])),
          { role: "user", content: "And grass?" },
        ],
      });
      const assistants = (prompt: LanguageModelV4Prompt) =>
        prompt.filter((message) => message.role === "assistant");
      const sent = assistants(next.doGenerateCalls[0].prompt);
      expect(sent).toEqual(assistants(sdkNext.doGenerateCalls[0].prompt));
      expect(sent).toEqual([
        {
          role: "assistant",
          content: [
            { type: "text", text: TEXT, providerOptions: CITED_METADATA },
          ],
          providerOptions: undefined,
        },
      ]);
    },
  );

  test.each(HOWS)(
    "%s keeps citations on an empty text part as the SDK's stream does",
    async (how) => {
      const t = initConvexTest();
      const threadId = await generate(t, how, citingModel(EMPTY_CITED));
      const [assistant] = await storedAssistants(t, threadId);
      expect(assistant.message!.content).toEqual([
        {
          type: "text",
          text: "",
          citations: CITATIONS,
          providerOptions: CITED_METADATA,
        },
        { type: "text", text: TEXT },
      ]);
      const sdk = await sdkUIMessage(citingModel(EMPTY_CITED));
      expect(textParts(sdk.parts)).toMatchObject([
        { text: "", citations: CITATIONS },
        { text: TEXT },
      ]);
      const { page } = await t.run((ctx) =>
        listUIMessages(ctx, component, {
          threadId,
          paginationOpts: { cursor: null, numItems: 10 },
        }),
      );
      const reloaded = page.find((m) => m.role === "assistant")!;
      expect(textParts(reloaded.parts)).toEqual(textParts(sdk.parts));
      if (how === "streamText") {
        const { streams, deltas } = await streamed(t, threadId);
        const [message] = await deriveUIMessagesFromDeltas(
          threadId,
          streams,
          deltas,
        );
        expect(textParts(message.parts)).toEqual(textParts(sdk.parts));
      }

      const next = citingModel(GRASS);
      await generate(t, "generateText", next, threadId, "And grass?");
      const sdkNext = citingModel(GRASS);
      await generateText({
        model: sdkNext,
        messages: [
          { role: "user", content: PROMPT },
          ...(await convertToModelMessages([sdk])),
          { role: "user", content: "And grass?" },
        ],
      });
      const assistants = (prompt: LanguageModelV4Prompt) =>
        prompt.filter((message) => message.role === "assistant");
      expect(assistants(next.doGenerateCalls[0].prompt)).toEqual(
        assistants(sdkNext.doGenerateCalls[0].prompt),
      );
    },
  );

  test("a step of only empty cited text saves it", async () => {
    const t = initConvexTest();
    const threadId = await generate(
      t,
      "generateText",
      citingModel([EMPTY_CITED[0]]),
    );
    const [assistant] = await storedAssistants(t, threadId);
    expect(assistant.message!.content).toEqual([
      {
        type: "text",
        text: "",
        citations: CITATIONS,
        providerOptions: CITED_METADATA,
      },
    ]);
  });

  test.each([
    { name: "no response messages", before: [] },
    { name: "approval tool responses", before: [APPROVAL_TOOL_RESPONSE] },
  ])(
    "empty cited text the SDK leaves no assistant message for is saved after $name",
    async ({ before }) => {
      const step = {
        content: [{ type: "text", ...EMPTY_CITED[0] }],
        text: "",
        sources: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: undefined,
        response: {
          id: "r",
          timestamp: new Date(0),
          modelId: "m",
          messages: [],
        },
        providerMetadata: undefined,
      } as unknown as StepResult<ToolSet>;
      const { messages } = await serializeResponseMessages(
        {} as ActionCtx,
        component as unknown as AgentComponent,
        step,
        undefined,
        before,
      );
      expect(messages.map(({ message }) => message)).toEqual([
        ...before,
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "",
              citations: CITATIONS,
              providerOptions: CITED_METADATA,
            },
          ],
        },
      ]);
    },
  );

  test("a stored message with citations saves and lists unchanged", async () => {
    const t = initConvexTest();
    const part = {
      type: "text" as const,
      text: TEXT,
      citations: CITATIONS,
      providerOptions: CITED_METADATA,
    };
    const threadId = await t.action(async (ctx) => {
      const threadId = await createThread(ctx, component, {});
      await agentWith(citingModel()).saveMessage(ctx, {
        threadId,
        message: { role: "assistant", content: [part] },
      });
      return threadId;
    });
    const [assistant] = await storedAssistants(t, threadId);
    expect(assistant.message!.content).toEqual([part]);
    const { page } = await t.run((ctx) =>
      listUIMessages(ctx, component, {
        threadId,
        paginationOpts: { cursor: null, numItems: 10 },
      }),
    );
    expect(textParts(page[0].parts)).toMatchObject([{ citations: CITATIONS }]);
  });

  test("UI messages round-trip their citations through MessageDocs", async () => {
    const sdk = await sdkUIMessage();
    const uiMessage: UIMessage = {
      ...sdk,
      key: "thread-0-0",
      order: 0,
      stepOrder: 0,
      status: "success",
      text: TEXT,
      _creationTime: 0,
    };
    const docs = await fromUIMessages([uiMessage], { threadId: "thread" });
    expect(docs[0].message!.content).toEqual([
      {
        type: "text",
        text: TEXT,
        citations: CITATIONS,
        providerOptions: CITED_METADATA,
      },
    ]);
    expect(textParts(toUIMessages(docs)[0].parts)).toEqual(
      textParts(sdk.parts),
    );
  });
});

/**
 * Rows a generation without citations writes, with ids and times left out
 * but their sizes kept, as recorded on main before citations were stored.
 */
async function rowsWithoutCitations(how: How) {
  const t = initConvexTest();
  await generate(
    t,
    how,
    citingModel([
      {
        text: TEXT,
        providerMetadata: { anthropic: { cacheCreationInputTokens: 0 } },
      },
    ]),
  );
  const rows = await t.run(async (ctx) => ({
    messages: await ctx.db.query("messages").collect(),
    streamingMessages: await ctx.db.query("streamingMessages").collect(),
    streamDeltas: await ctx.db.query("streamDeltas").collect(),
  }));
  const ids = new Map<string, string>();
  const anonymize = (value: unknown, key?: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => anonymize(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, anonymize(v, k)]),
      );
    }
    if (
      typeof value === "number" &&
      (key === "_creationTime" || key?.endsWith("At"))
    ) {
      return 0;
    }
    if (
      typeof value === "string" &&
      (key === "_id" || key?.endsWith("Id") || key === "messageId")
    ) {
      if (!ids.has(value)) ids.set(value, `id${ids.size}`);
      return ids.get(value);
    }
    return value;
  };
  return Object.fromEntries(
    Object.entries(rows).map(([table, docs]) => [
      table,
      docs.map((doc) => ({
        size: getDocumentSize(doc),
        doc: anonymize(doc),
      })),
    ]),
  );
}

describe("messages without citations", () => {
  test("generateText writes the same rows as before", async () => {
    expect(await rowsWithoutCitations("generateText")).toMatchInlineSnapshot(`
      {
        "messages": [
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id0",
              "message": {
                "content": "Why is the sky blue?",
                "role": "user",
              },
              "order": 0,
              "status": "success",
              "stepOrder": 0,
              "text": "Why is the sky blue?",
              "threadId": "id1",
              "tool": false,
            },
            "size": 240,
          },
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id2",
              "agentName": "citations",
              "finishReason": "stop",
              "message": {
                "content": [
                  {
                    "providerOptions": {
                      "anthropic": {
                        "cacheCreationInputTokens": 0,
                      },
                    },
                    "text": "The sky is blue because of Rayleigh scattering.",
                    "type": "text",
                  },
                ],
                "role": "assistant",
              },
              "model": "mock-model-id",
              "order": 0,
              "parentMessageId": "id0",
              "provider": "mock-provider",
              "sources": [],
              "status": "success",
              "stepOrder": 1,
              "text": "The sky is blue because of Rayleigh scattering.",
              "threadId": "id1",
              "tool": false,
              "usage": {
                "cacheWriteInputTokens": 0,
                "cachedInputTokens": 0,
                "completionTokens": 10,
                "nonCachedInputTokens": 3,
                "promptTokens": 3,
                "reasoningTokens": 0,
                "textOutputTokens": 10,
                "totalTokens": 13,
              },
              "warnings": [],
            },
            "size": 755,
          },
        ],
        "streamDeltas": [],
        "streamingMessages": [],
      }
    `);
  });

  test("streamText writes the same rows as before", async () => {
    expect(await rowsWithoutCitations("streamText")).toMatchInlineSnapshot(`
      {
        "messages": [
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id0",
              "message": {
                "content": "Why is the sky blue?",
                "role": "user",
              },
              "order": 0,
              "status": "success",
              "stepOrder": 0,
              "text": "Why is the sky blue?",
              "threadId": "id1",
              "tool": false,
            },
            "size": 240,
          },
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id2",
              "agentName": "citations",
              "finishReason": "stop",
              "message": {
                "content": [
                  {
                    "providerOptions": {
                      "anthropic": {
                        "cacheCreationInputTokens": 0,
                      },
                    },
                    "text": "The sky is blue because of Rayleigh scattering.",
                    "type": "text",
                  },
                ],
                "role": "assistant",
              },
              "model": "mock-model-id",
              "order": 0,
              "parentMessageId": "id0",
              "provider": "mock-provider",
              "sources": [],
              "status": "success",
              "stepOrder": 1,
              "text": "The sky is blue because of Rayleigh scattering.",
              "threadId": "id1",
              "tool": false,
              "usage": {
                "cacheWriteInputTokens": 0,
                "cachedInputTokens": 0,
                "completionTokens": 10,
                "nonCachedInputTokens": 3,
                "promptTokens": 3,
                "reasoningTokens": 0,
                "textOutputTokens": 10,
                "totalTokens": 13,
              },
              "warnings": [],
            },
            "size": 755,
          },
        ],
        "streamDeltas": [
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id3",
              "end": 1,
              "parts": [
                {
                  "type": "start",
                },
              ],
              "start": 0,
              "streamId": "id4",
            },
            "size": 156,
          },
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id5",
              "end": 2,
              "parts": [
                {
                  "type": "start-step",
                },
              ],
              "start": 1,
              "streamId": "id4",
            },
            "size": 161,
          },
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id6",
              "end": 3,
              "parts": [
                {
                  "id": "0",
                  "type": "text-start",
                },
              ],
              "start": 2,
              "streamId": "id4",
            },
            "size": 167,
          },
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id7",
              "end": 4,
              "parts": [
                {
                  "delta": "The ",
                  "id": "0",
                  "type": "text-delta",
                },
              ],
              "start": 3,
              "streamId": "id4",
            },
            "size": 179,
          },
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id8",
              "end": 5,
              "parts": [
                {
                  "delta": "sky ",
                  "id": "0",
                  "type": "text-delta",
                },
              ],
              "start": 4,
              "streamId": "id4",
            },
            "size": 179,
          },
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id9",
              "end": 6,
              "parts": [
                {
                  "delta": "is ",
                  "id": "0",
                  "type": "text-delta",
                },
              ],
              "start": 5,
              "streamId": "id4",
            },
            "size": 178,
          },
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id10",
              "end": 7,
              "parts": [
                {
                  "delta": "blue ",
                  "id": "0",
                  "type": "text-delta",
                },
              ],
              "start": 6,
              "streamId": "id4",
            },
            "size": 180,
          },
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id11",
              "end": 8,
              "parts": [
                {
                  "delta": "because ",
                  "id": "0",
                  "type": "text-delta",
                },
              ],
              "start": 7,
              "streamId": "id4",
            },
            "size": 183,
          },
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id12",
              "end": 9,
              "parts": [
                {
                  "delta": "of ",
                  "id": "0",
                  "type": "text-delta",
                },
              ],
              "start": 8,
              "streamId": "id4",
            },
            "size": 178,
          },
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id13",
              "end": 10,
              "parts": [
                {
                  "delta": "Rayleigh ",
                  "id": "0",
                  "type": "text-delta",
                },
              ],
              "start": 9,
              "streamId": "id4",
            },
            "size": 184,
          },
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id14",
              "end": 11,
              "parts": [
                {
                  "delta": "scattering.",
                  "id": "0",
                  "type": "text-delta",
                },
              ],
              "start": 10,
              "streamId": "id4",
            },
            "size": 186,
          },
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id15",
              "end": 12,
              "parts": [
                {
                  "id": "0",
                  "providerMetadata": {
                    "anthropic": {
                      "cacheCreationInputTokens": 0,
                    },
                  },
                  "type": "text-end",
                },
              ],
              "start": 11,
              "streamId": "id4",
            },
            "size": 230,
          },
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id16",
              "end": 13,
              "parts": [
                {
                  "type": "finish-step",
                },
              ],
              "start": 12,
              "streamId": "id4",
            },
            "size": 162,
          },
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id17",
              "end": 14,
              "parts": [
                {
                  "finishReason": "stop",
                  "type": "finish",
                },
              ],
              "start": 13,
              "streamId": "id4",
            },
            "size": 176,
          },
        ],
        "streamingMessages": [
          {
            "doc": {
              "_creationTime": 0,
              "_id": "id4",
              "agentName": "citations",
              "format": "UIMessageChunk",
              "model": "mock-model-id",
              "order": 0,
              "provider": "mock-provider",
              "state": {
                "cleanupFnId": "id18",
                "endedAt": 0,
                "kind": "finished",
              },
              "stepOrder": 1,
              "threadId": "id1",
            },
            "size": 315,
          },
        ],
      }
    `);
  });
});
