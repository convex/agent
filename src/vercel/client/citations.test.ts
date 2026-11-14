import { describe, expect, test } from "vitest";
import type {
  LanguageModelV4Content,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
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
const CITED_PART = {
  type: "text" as const,
  text: TEXT,
  citations: CITATIONS,
  providerOptions: CITED_METADATA,
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

async function reload(t: T, threadId: string) {
  const { page } = await t.run((ctx) =>
    listUIMessages(ctx, component, {
      threadId,
      paginationOpts: { cursor: null, numItems: 10 },
    }),
  );
  return page.find((m) => m.role === "assistant")!;
}

async function serialize(
  texts: CitedText[],
  text: string,
  responseMessages: ModelMessage[],
) {
  const step = {
    content: texts.map((part) => ({ type: "text", ...part })),
    text,
    sources: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    warnings: undefined,
    response: { id: "r", timestamp: new Date(0), modelId: "m", messages: [] },
    providerMetadata: undefined,
  } as unknown as StepResult<ToolSet>;
  const { messages } = await serializeResponseMessages(
    {} as ActionCtx,
    component as unknown as AgentComponent,
    step,
    undefined,
    responseMessages,
  );
  return messages.map(({ message }) => message);
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
      content: [CITED_PART],
    });
  });

  test("a saved step keeps its citations on reload, and the next call gets the text the SDK sends", async () => {
    const t = initConvexTest();
    const threadId = await generate(t, "streamText");
    const [assistant] = await storedAssistants(t, threadId);
    expect(assistant.message!.content).toEqual([CITED_PART]);
    expect(textParts((await reload(t, threadId)).parts)).toEqual(
      textParts((await sdkUIMessage()).parts),
    );
    const next = citingModel(GRASS);
    await generate(t, "generateText", next, threadId, "And grass?");
    expect(
      next.doGenerateCalls[0].prompt.filter((m) => m.role === "assistant"),
    ).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: TEXT, providerOptions: CITED_METADATA },
        ],
        providerOptions: undefined,
      },
    ]);
  });

  test("citations on an empty text part are kept as the SDK's stream does", async () => {
    const t = initConvexTest();
    const threadId = await generate(
      t,
      "generateText",
      citingModel(EMPTY_CITED),
    );
    const [assistant] = await storedAssistants(t, threadId);
    expect(assistant.message!.content).toEqual([
      { ...CITED_PART, text: "" },
      { type: "text", text: TEXT },
    ]);
    const sdk = await sdkUIMessage(citingModel(EMPTY_CITED));
    expect(textParts((await reload(t, threadId)).parts)).toEqual(
      textParts(sdk.parts),
    );
  });

  test.each([
    { name: "no response messages", before: [] },
    { name: "approval tool responses", before: [APPROVAL_TOOL_RESPONSE] },
  ])(
    "empty cited text the SDK leaves no assistant message for is saved after $name",
    async ({ before }) => {
      const messages = await serialize([EMPTY_CITED[0]], "", before);
      expect(messages).toEqual([
        ...before,
        { role: "assistant", content: [{ ...CITED_PART, text: "" }] },
      ]);
    },
  );

  // ai 7.0.163 started keeping empty text that has provider metadata in its
  // response messages (https://github.com/vercel/ai/pull/24405); earlier
  // versions in the peer range drop all empty text.
  test.each([
    { name: "drops empty text", keepsEmptyWithMetadata: false },
    { name: "keeps empty text with metadata", keepsEmptyWithMetadata: true },
  ])(
    "empty cited text is saved once when the SDK $name",
    async ({ keepsEmptyWithMetadata }) => {
      const messages = await serialize(EMPTY_CITED, TEXT, [
        {
          role: "assistant",
          content: [
            ...(keepsEmptyWithMetadata
              ? [
                  {
                    type: "text" as const,
                    text: "",
                    providerOptions: CITED_METADATA,
                  },
                ]
              : []),
            { type: "text", text: TEXT },
          ],
        },
      ]);
      expect(messages).toEqual([
        {
          role: "assistant",
          content: [
            { ...CITED_PART, text: "" },
            { type: "text", text: TEXT },
          ],
        },
      ]);
    },
  );

  test("a message saved with citations lists them", async () => {
    const t = initConvexTest();
    const threadId = await t.action(async (ctx) => {
      const threadId = await createThread(ctx, component, {});
      await agentWith(citingModel()).saveMessage(ctx, {
        threadId,
        message: { role: "assistant", content: [CITED_PART] },
      });
      return threadId;
    });
    const [assistant] = await storedAssistants(t, threadId);
    expect(assistant.message!.content).toEqual([CITED_PART]);
    expect(textParts((await reload(t, threadId)).parts)).toMatchObject([
      { citations: CITATIONS },
    ]);
  });

  test("UI messages round-trip their citations and provider metadata through MessageDocs", async () => {
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
    expect(docs[0].message!.content).toEqual([CITED_PART]);
    const [part] = toUIMessages(docs)[0].parts.filter((p) => p.type === "text");
    expect(part).toMatchObject({
      citations: CITATIONS,
      providerMetadata: CITED_METADATA,
    });
  });
});
