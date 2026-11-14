import { describe, expect, test } from "vitest";
import type { LanguageModelV4Content } from "@ai-sdk/provider";
import {
  convertToModelMessages,
  readUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage,
  type ProviderMetadata,
  type UIMessage as AIUIMessage,
} from "ai";
import { z } from "zod/v4";
import {
  Agent,
  createThread,
  fromUIMessages,
  listUIMessages,
  saveMessages,
  toUIMessages,
  type UIMessage,
} from "../index.js";
import { combineUIMessages } from "../UIMessages.js";
import { docsToModelMessages } from "../mapping.js";
import { sorted } from "../../shared.js";
import type { MessageDoc } from "../../validators.js";
import { MockLanguageModel } from "./mockModel.js";
import { initConvexTest } from "../../component/setup.test.js";
import { api } from "../../component/_generated/api.js";
import type { ComponentApi } from "../../component/_generated/component.js";

const component = api as unknown as ComponentApi;
type T = ReturnType<typeof initConvexTest>;

const STEP_METADATA = {
  anthropic: { stopSequence: null, usage: { input_tokens: 3 } },
} satisfies ProviderMetadata;

const tools = {
  lookup: tool({
    inputSchema: z.object({ query: z.string() }),
    execute: async () => "Rayleigh scattering",
  }),
};

const CITED_STEPS: LanguageModelV4Content[][] = [
  [
    {
      type: "reasoning",
      text: "Look it up first.",
      providerMetadata: { anthropic: { signature: "sig-1" } },
    },
    {
      type: "text",
      text: "Let me check.",
      providerMetadata: { anthropic: { citations: ["first"] } },
    },
    {
      type: "source",
      sourceType: "url",
      id: "src-1",
      url: "https://example.com/sky",
      title: "Sky",
      providerMetadata: { anthropic: { encryptedIndex: "abc" } },
    },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "lookup",
      input: JSON.stringify({ query: "sky" }),
      providerMetadata: { google: { thoughtSignature: "call-sig" } },
    },
  ],
  [
    {
      type: "text",
      text: "The sky scatters blue light.",
      providerMetadata: { anthropic: { citations: ["second"] } },
    },
    {
      type: "text",
      text: "So it looks blue.",
      providerMetadata: { anthropic: { citations: ["third"] } },
    },
  ],
];

const FILE: LanguageModelV4Content = {
  type: "file",
  mediaType: "image/png",
  data: { type: "data", data: "iVBORw0KGgo=" },
  providerMetadata: { google: { thoughtSignature: "file-sig" } },
};
const CITED_STEPS_WITH_FILE = [
  [...CITED_STEPS[0], FILE],
  ...CITED_STEPS.slice(1),
];

const UNCITED_STEPS: LanguageModelV4Content[][] = [
  [
    { type: "reasoning", text: "Look it up first." },
    { type: "text", text: "Let me check." },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "lookup",
      input: JSON.stringify({ query: "sky" }),
    },
  ],
  [{ type: "text", text: "The sky scatters blue light." }],
];

const model = (contentSteps: LanguageModelV4Content[][]) =>
  new MockLanguageModel({ contentSteps, providerMetadata: STEP_METADATA });

async function sdkUIMessage(contentSteps = CITED_STEPS): Promise<AIUIMessage> {
  const result = streamText({
    model: model(contentSteps),
    prompt: "Why is the sky blue?",
    tools,
    stopWhen: stepCountIs(2),
  });
  let last: AIUIMessage | undefined;
  for await (const message of readUIMessageStream({
    stream: result.toUIMessageStream({ sendSources: true }),
  })) {
    last = message;
  }
  return last!;
}

async function generate(t: T, contentSteps: LanguageModelV4Content[][]) {
  return t.action(async (ctx) => {
    const threadId = await createThread(ctx, component, {});
    const agent = new Agent(component, {
      name: "metadata",
      languageModel: model(contentSteps),
      tools,
    });
    const result = await agent.streamText(
      ctx,
      { threadId },
      { prompt: "Why is the sky blue?", stopWhen: stepCountIs(2) },
    );
    await result.consumeStream();
    return threadId;
  });
}

async function listed(t: T, threadId: string) {
  const { page } = await t.run((ctx) =>
    listUIMessages(ctx, component, {
      threadId,
      paginationOpts: { cursor: null, numItems: 20 },
    }),
  );
  return page;
}

type AnyPart = Record<string, unknown> & { type: string };

function partMetadata(parts: readonly unknown[], type: string) {
  return (parts as AnyPart[])
    .filter((part) => part.type === type)
    .map((part) => ({
      providerMetadata: part.providerMetadata,
      callProviderMetadata: part.callProviderMetadata,
      resultProviderMetadata: part.resultProviderMetadata,
    }));
}

function contentOptions(messages: ModelMessage[]) {
  return messages.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : message.content.map((part) => ({
          type: part.type,
          key:
            "text" in part
              ? part.text
              : "toolCallId" in part
                ? part.toolCallId
                : part.type,
          providerOptions:
            "providerOptions" in part ? part.providerOptions : undefined,
        })),
  );
}

function byKey(parts: ReturnType<typeof contentOptions>) {
  return [...parts].sort((a, b) =>
    `${a.type}:${a.key}`.localeCompare(`${b.type}:${b.key}`),
  );
}

describe("per-part provider metadata in UI messages", () => {
  test("saved parts carry the metadata the SDK's UI stream gives them", async () => {
    const t = initConvexTest();
    const threadId = await generate(t, CITED_STEPS_WITH_FILE);
    const [assistant] = (await listed(t, threadId)).filter(
      (message) => message.role === "assistant",
    );
    const sdk = await sdkUIMessage(CITED_STEPS_WITH_FILE);
    for (const type of [
      "reasoning",
      "text",
      "file",
      "source-url",
      "tool-lookup",
    ]) {
      expect(partMetadata(assistant.parts, type), type).toEqual(
        partMetadata(sdk.parts, type),
      );
    }
  });

  test("UI messages round-trip to model parts with the SDK's provider options", async () => {
    const t = initConvexTest();
    const threadId = await generate(t, CITED_STEPS);
    const assistants = (await listed(t, threadId)).filter(
      (message) => message.role === "assistant",
    );
    const docs = await fromUIMessages(assistants, { threadId });
    const sdk = await convertToModelMessages([await sdkUIMessage()]);
    expect(contentOptions(sdk)).toContainEqual({
      type: "text",
      key: "So it looks blue.",
      providerOptions: { anthropic: { citations: ["third"] } },
    });
    expect(byKey(contentOptions(docsToModelMessages(docs)))).toEqual(
      byKey(contentOptions(sdk)),
    );
  });

  test("a user text part keeps its own provider options", async () => {
    const t = initConvexTest();
    const cacheControl = { anthropic: { cacheControl: { type: "ephemeral" } } };
    const threadId = await t.action(async (ctx) => {
      const threadId = await createThread(ctx, component, {});
      await saveMessages(ctx, component, {
        threadId,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Long context",
                providerOptions: cacheControl,
              },
              { type: "text", text: "Question" },
            ],
          },
        ],
        metadata: [{ providerMetadata: { human: { name: "Ada" } } }],
      });
      return threadId;
    });
    const [user] = await listed(t, threadId);
    expect(partMetadata(user.parts, "text")).toEqual([
      { providerMetadata: cacheControl },
      {},
    ]);
    const docs = await fromUIMessages([user], { threadId });
    expect(contentOptions(docsToModelMessages(docs))).toEqual([
      { type: "text", key: "Long context", providerOptions: cacheControl },
      { type: "text", key: "Question", providerOptions: undefined },
    ]);
  });

  test("a call and its result split across pages keep their own metadata", () => {
    const call = doc({
      _id: "call",
      stepOrder: 1,
      tool: true,
      providerMetadata: STEP_METADATA,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "lookup",
            input: { query: "sky" },
            providerOptions: { google: { thoughtSignature: "call-sig" } },
          },
        ],
      },
    });
    const result = doc({
      _id: "result",
      stepOrder: 2,
      tool: true,
      message: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "lookup",
            output: { type: "text", value: "Rayleigh scattering" },
            providerOptions: { google: { resultId: "result-1" } },
          },
        ],
      },
    });
    const expected = [
      {
        providerMetadata: undefined,
        callProviderMetadata: { google: { thoughtSignature: "call-sig" } },
        resultProviderMetadata: { google: { resultId: "result-1" } },
      },
    ];
    const [together] = toUIMessages([call, result]);
    expect(partMetadata(together.parts, "tool-lookup")).toEqual(expected);
    const [paged] = combineUIMessages([
      ...toUIMessages([call]),
      ...toUIMessages([result]),
    ]);
    expect(partMetadata(paged.parts, "tool-lookup")).toEqual(expected);
  });

  test("a streaming tool call shows its own metadata", () => {
    const [message] = toUIMessages([
      {
        ...doc({
          _id: "call",
          status: "pending",
          providerMetadata: STEP_METADATA,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "lookup",
                input: { query: "sky" },
                providerOptions: { google: { thoughtSignature: "call-sig" } },
              },
            ],
          },
        }),
        streaming: true,
      },
    ]);
    expect(message.parts.at(-1)).toMatchObject({
      state: "input-streaming",
      callProviderMetadata: { google: { thoughtSignature: "call-sig" } },
    });
  });

  test("a human tool result on another page never overwrites its call's metadata", async () => {
    const t = initConvexTest();
    const threadId = await saveHumanToolResult(t, {
      google: { thoughtSignature: "call-sig" },
    });
    const expected = [
      {
        providerMetadata: undefined,
        callProviderMetadata: { google: { thoughtSignature: "call-sig" } },
        resultProviderMetadata: { human: { name: "Ada" } },
      },
    ];
    const [, paged] = await listedInPages(t, threadId);
    expect(partMetadata(paged.parts, "tool-lookup")).toEqual(expected);
    const [, together] = await listed(t, threadId);
    expect(partMetadata(together.parts, "tool-lookup")).toEqual(expected);
  });

  test("tool results saved with message-level metadata list it as the result's", async () => {
    const t = initConvexTest();
    const threadId = await saveHumanToolResult(t);
    const [, together] = await listed(t, threadId);
    const [, paged] = await listedInPages(t, threadId);
    expect(stable([together, paged])).toMatchInlineSnapshot(`
      "[
        {
          "_creationTime": "_creationTime",
          "id": "id",
          "key": "key",
          "order": 0,
          "parts": [
            {
              "type": "step-start"
            },
            {
              "input": {
                "query": "sky"
              },
              "output": "Rayleigh scattering",
              "resultProviderMetadata": {
                "human": {
                  "name": "Ada"
                }
              },
              "state": "output-available",
              "toolCallId": "call-1",
              "type": "tool-lookup"
            }
          ],
          "role": "assistant",
          "status": "success",
          "stepOrder": 1,
          "text": ""
        },
        {
          "_creationTime": "_creationTime",
          "id": "id",
          "key": "key",
          "order": 0,
          "parts": [
            {
              "type": "step-start"
            },
            {
              "input": {
                "query": "sky"
              },
              "state": "output-available",
              "toolCallId": "call-1",
              "type": "tool-lookup",
              "output": "Rayleigh scattering",
              "resultProviderMetadata": {
                "human": {
                  "name": "Ada"
                }
              }
            }
          ],
          "role": "assistant",
          "status": "success",
          "stepOrder": 1,
          "text": ""
        }
      ]"
    `);
  });

  test("the message's metadata never lands on a part once parts have their own", () => {
    const [message] = toUIMessages([
      doc({
        providerMetadata: { anthropic: { signature: "first-part" } },
        reasoning: "Stored only on the message.",
        tool: true,
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Cited.",
              providerOptions: { anthropic: { signature: "first-part" } },
            },
            { type: "text", text: "Not cited." },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "lookup",
              input: { query: "sky" },
            },
          ],
        },
      }),
    ]);
    expect(
      message.parts.map((part) => ({ type: part.type, ...metadataOf(part) })),
    ).toEqual([
      { type: "reasoning" },
      {
        type: "text",
        providerMetadata: { anthropic: { signature: "first-part" } },
      },
      { type: "text" },
      { type: "step-start" },
      { type: "tool-lookup" },
    ]);
  });

  test("docs made by fromUIMessages list each part with only its own metadata", async () => {
    const signed = { anthropic: { signature: "sig-1" } };
    const cited = { anthropic: { citations: ["first"] } };
    const ui: UIMessage = {
      id: "ui",
      key: "ui",
      order: 0,
      stepOrder: 0,
      status: "success",
      text: "Plain. Cited.",
      _creationTime: 0,
      role: "assistant",
      parts: [
        { type: "reasoning", text: "Think.", providerMetadata: signed },
        { type: "text", text: "Plain." },
        { type: "text", text: "Cited.", providerMetadata: cited },
      ],
    };
    const docs = await fromUIMessages([ui], { threadId: "thread" });
    expect(docs[0].providerMetadata).toEqual(signed);
    const [message] = toUIMessages(docs);
    expect(message.parts.map(metadataOf)).toEqual([
      { providerMetadata: signed },
      {},
      { providerMetadata: cited },
    ]);
  });

  test("a provider-executed result keeps its own metadata beside its call's", () => {
    const [message] = toUIMessages([
      doc({
        providerMetadata: STEP_METADATA,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "web_search",
              input: { query: "sky" },
              providerExecuted: true,
              providerOptions: { anthropic: { caller: "direct" } },
            },
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "web_search",
              output: { type: "json", value: [] },
              providerOptions: { anthropic: { searchId: "search-1" } },
            },
          ],
        },
      }),
    ]);
    expect(partMetadata(message.parts, "tool-web_search")).toEqual([
      {
        providerMetadata: undefined,
        callProviderMetadata: { anthropic: { caller: "direct" } },
        resultProviderMetadata: { anthropic: { searchId: "search-1" } },
      },
    ]);
  });

  test("a streaming tool call without its own metadata shows none", () => {
    const [message] = toUIMessages([
      {
        ...doc({
          status: "pending",
          providerMetadata: STEP_METADATA,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "lookup",
                input: { query: "sky" },
              },
            ],
          },
        }),
        streaming: true,
      },
    ]);
    expect(message.parts.at(-1)).not.toHaveProperty("callProviderMetadata");
  });

  test("messages saved without per-part metadata list exactly as before", async () => {
    const t = initConvexTest();
    const threadId = await generate(t, UNCITED_STEPS);
    await t.action(async (ctx) => {
      await saveMessages(ctx, component, {
        threadId,
        messages: [
          { role: "system", content: "Be brief." },
          {
            role: "user",
            content: [
              { type: "text", text: "And grass?" },
              {
                type: "file",
                mediaType: "text/plain",
                data: "https://example.com/grass.txt",
              },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "Chlorophyll." },
              { type: "text", text: "Grass is green." },
            ],
          },
        ],
        metadata: [
          { providerMetadata: { human: { name: "Ada" } } },
          { providerMetadata: { human: { name: "Ada" } } },
          {
            providerMetadata: { human: { name: "Bob" } },
            sources: [
              {
                type: "source",
                sourceType: "url",
                id: "src-2",
                url: "https://example.com/grass",
                providerMetadata: { human: { trust: "high" } },
              },
            ],
          },
        ],
      });
    });
    expect(stable(await listed(t, threadId))).toMatchInlineSnapshot(`
      "[
        {
          "_creationTime": "_creationTime",
          "id": "id",
          "key": "key",
          "order": 0,
          "parts": [
            {
              "state": "done",
              "text": "Why is the sky blue?",
              "type": "text"
            }
          ],
          "role": "user",
          "status": "success",
          "stepOrder": 0,
          "text": "Why is the sky blue?"
        },
        {
          "_creationTime": "_creationTime",
          "agentName": "metadata",
          "id": "id",
          "key": "key",
          "order": 0,
          "parts": [
            {
              "providerMetadata": {
                "anthropic": {
                  "stopSequence": null,
                  "usage": {
                    "input_tokens": 3
                  }
                }
              },
              "state": "done",
              "text": "Look it up first.",
              "type": "reasoning"
            },
            {
              "providerMetadata": {
                "anthropic": {
                  "stopSequence": null,
                  "usage": {
                    "input_tokens": 3
                  }
                }
              },
              "state": "done",
              "text": "Let me check.",
              "type": "text"
            },
            {
              "type": "step-start"
            },
            {
              "callProviderMetadata": {
                "anthropic": {
                  "stopSequence": null,
                  "usage": {
                    "input_tokens": 3
                  }
                }
              },
              "input": {
                "query": "sky"
              },
              "output": "Rayleigh scattering",
              "state": "output-available",
              "toolCallId": "call-1",
              "type": "tool-lookup"
            },
            {
              "providerMetadata": {
                "anthropic": {
                  "stopSequence": null,
                  "usage": {
                    "input_tokens": 3
                  }
                }
              },
              "state": "done",
              "text": "The sky scatters blue light.",
              "type": "text"
            }
          ],
          "role": "assistant",
          "status": "success",
          "stepOrder": 1,
          "text": "Let me check. The sky scatters blue light."
        },
        {
          "_creationTime": "_creationTime",
          "id": "id",
          "key": "key",
          "order": 0,
          "parts": [
            {
              "providerMetadata": {
                "human": {
                  "name": "Ada"
                }
              },
              "state": "done",
              "text": "Be brief.",
              "type": "text"
            }
          ],
          "role": "system",
          "status": "success",
          "stepOrder": 4,
          "text": "Be brief."
        },
        {
          "_creationTime": "_creationTime",
          "id": "id",
          "key": "key",
          "order": 1,
          "parts": [
            {
              "providerMetadata": {
                "human": {
                  "name": "Ada"
                }
              },
              "state": "done",
              "text": "And grass?",
              "type": "text"
            },
            {
              "mediaType": "text/plain",
              "type": "file",
              "url": "https://example.com/grass.txt"
            }
          ],
          "role": "user",
          "status": "success",
          "stepOrder": 0,
          "text": "And grass?"
        },
        {
          "_creationTime": "_creationTime",
          "id": "id",
          "key": "key",
          "order": 1,
          "parts": [
            {
              "providerMetadata": {
                "human": {
                  "name": "Bob"
                }
              },
              "state": "done",
              "text": "Chlorophyll.",
              "type": "reasoning"
            },
            {
              "providerMetadata": {
                "human": {
                  "name": "Bob"
                }
              },
              "state": "done",
              "text": "Grass is green.",
              "type": "text"
            },
            {
              "providerMetadata": {
                "human": {
                  "trust": "high"
                }
              },
              "sourceId": "src-2",
              "type": "source-url",
              "url": "https://example.com/grass"
            }
          ],
          "role": "assistant",
          "status": "success",
          "stepOrder": 1,
          "text": "Grass is green."
        }
      ]"
    `);
  });
});

function metadataOf(part: object) {
  const { providerMetadata, callProviderMetadata, resultProviderMetadata } =
    part as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries({
      providerMetadata,
      callProviderMetadata,
      resultProviderMetadata,
    }).filter(([, value]) => value !== undefined),
  );
}

async function saveHumanToolResult(t: T, callOptions?: ProviderMetadata) {
  return t.action(async (ctx) => {
    const threadId = await createThread(ctx, component, {});
    await saveMessages(ctx, component, {
      threadId,
      messages: [
        { role: "user", content: "Why is the sky blue?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "lookup",
              input: { query: "sky" },
              ...(callOptions ? { providerOptions: callOptions } : {}),
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
              output: { type: "text", value: "Rayleigh scattering" },
            },
          ],
        },
      ],
      metadata: [{}, {}, { providerMetadata: { human: { name: "Ada" } } }],
    });
    return threadId;
  });
}

async function listedInPages(t: T, threadId: string) {
  const pages: UIMessage[][] = [];
  let cursor: string | null = null;
  for (;;) {
    const result = await t.run((ctx) =>
      listUIMessages(ctx, component, {
        threadId,
        paginationOpts: { cursor, numItems: 1 },
      }),
    );
    pages.push(result.page);
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  return combineUIMessages(sorted(pages.flat()));
}

function doc(overrides: Partial<MessageDoc>): MessageDoc {
  return {
    _id: "msg",
    _creationTime: 0,
    order: 0,
    stepOrder: 0,
    status: "success",
    threadId: "thread",
    tool: false,
    ...overrides,
  };
}

function stable(page: UIMessage[]) {
  return JSON.stringify(
    page,
    (key, value) =>
      key === "_creationTime" || key === "id" || key === "key" ? key : value,
    2,
  );
}
