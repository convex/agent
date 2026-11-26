import { describe, expect, test } from "vitest";
import type { LanguageModelV4Content } from "@ai-sdk/provider";
import {
  dynamicTool,
  readUIMessageStream,
  stepCountIs,
  tool,
  type ToolSet,
  type UIMessage as AIUIMessage,
} from "ai";
import { z } from "zod/v4";
import {
  Agent,
  createThread,
  createTool,
  listUIMessages,
  toUIMessages,
} from "../index.js";
import type { MessageDoc } from "../../validators.js";
import { mockModel } from "./mockModel.js";
import { components, initConvexTest } from "./setup.test.js";

type T = ReturnType<typeof initConvexTest>;

const tools = {
  weather: createTool({
    title: "Weather",
    metadata: { source: "mcp-weather" },
    inputSchema: z.object({ city: z.string() }),
    execute: async () => "sunny",
  }),
  plain: createTool({
    inputSchema: z.object({ city: z.string() }),
    execute: async () => "plain",
  }),
  lookup: dynamicTool({
    title: "Lookup",
    metadata: { source: "mcp-lookup" },
    inputSchema: z.object({ city: z.string() }),
    execute: async () => "found",
  }),
  web_search: tool({
    type: "provider",
    id: "test.web_search",
    args: {},
    isProviderExecuted: true,
    title: "Web search",
    metadata: { source: "provider" },
    inputSchema: z.object({ city: z.string() }),
  }),
  confirm: createTool({
    title: "Confirm",
    metadata: { source: "mcp-confirm" },
    needsApproval: true,
    inputSchema: z.object({ city: z.string() }),
    execute: async () => "confirmed",
  }),
} satisfies ToolSet;

const call = (toolCallId: string, toolName: string) =>
  ({
    type: "tool-call",
    toolCallId,
    toolName,
    input: JSON.stringify({ city: "Paris" }),
  }) satisfies LanguageModelV4Content;

async function streamAndList(t: T, steps: LanguageModelV4Content[][]) {
  const { threadId, streamed } = await t.action(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, {});
    const agent = new Agent(components.agent, {
      name: "meta",
      tools,
      stopWhen: stepCountIs(3),
      languageModel: mockModel({ contentSteps: steps }),
    });
    const result = await agent.streamText(
      ctx,
      { threadId },
      { prompt: "Weather in Paris?" },
    );
    let streamed: AIUIMessage | undefined;
    for await (const message of readUIMessageStream({
      stream: result.toUIMessageStream(),
    })) {
      streamed = message;
    }
    return { threadId, streamed: streamed! };
  });
  const { page } = await t.run((ctx) =>
    listUIMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 20 },
    }),
  );
  const reloaded = page.filter((message) => message.role === "assistant");
  return {
    streamed: toolParts(streamed.parts),
    reloaded: toolParts(reloaded.flatMap((m) => m.parts)),
  };
}

function toolParts(parts: readonly unknown[]) {
  return Object.fromEntries(
    (parts as Record<string, unknown>[])
      .filter((part) => typeof part.toolCallId === "string")
      .map((part) => [
        part.toolCallId,
        Object.fromEntries(
          ["state", "title", "toolMetadata"]
            .filter((key) => key in part)
            .map((key) => [key, part[key]]),
        ),
      ]),
  );
}

describe("tool title and metadata after reload", () => {
  test("a reloaded tool part keeps the title and metadata it streamed with", async () => {
    const t = initConvexTest();
    const { streamed, reloaded } = await streamAndList(t, [
      [
        call("c-weather", "weather"),
        call("c-plain", "plain"),
        call("c-lookup", "lookup"),
        call("c-search", "web_search"),
        {
          type: "tool-result",
          toolCallId: "c-search",
          toolName: "web_search",
          result: { hits: 1 },
        },
      ],
      [{ type: "text", text: "It is sunny." }],
    ]);
    expect(streamed["c-weather"]).toStrictEqual({
      state: "output-available",
      title: "Weather",
      toolMetadata: { source: "mcp-weather" },
    });
    expect(streamed["c-plain"]).toStrictEqual({ state: "output-available" });
    expect(reloaded).toStrictEqual(streamed);
  });

  test("a tool part awaiting approval keeps its title and metadata", async () => {
    const t = initConvexTest();
    const { streamed, reloaded } = await streamAndList(t, [
      [call("c-confirm", "confirm")],
    ]);
    expect(streamed["c-confirm"]).toStrictEqual({
      state: "approval-requested",
      title: "Confirm",
      toolMetadata: { source: "mcp-confirm" },
    });
    expect(reloaded).toStrictEqual(streamed);
  });

  test("a stored tool call shows its title and metadata", () => {
    const [message] = toUIMessages([
      {
        _id: "msg",
        _creationTime: 0,
        order: 0,
        stepOrder: 0,
        status: "success",
        threadId: "thread",
        tool: true,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "c-weather",
              toolName: "weather",
              input: { city: "Paris" },
              title: "Weather",
              toolMetadata: { source: "mcp-weather" },
            },
          ],
        },
      } satisfies MessageDoc,
    ]);
    expect(toolParts(message.parts)).toStrictEqual({
      "c-weather": {
        state: "input-available",
        title: "Weather",
        toolMetadata: { source: "mcp-weather" },
      },
    });
  });
});
