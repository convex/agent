import { describe, expect, test } from "vitest";
import type { LanguageModelV4Content } from "@ai-sdk/provider";
import {
  dynamicTool,
  generateText,
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
import { projectPersistedUIMessageChunks } from "../../streaming/materializePersistedUIMessageChunks.js";
import type { MessageDoc } from "../../validators.js";
import { mockModel } from "./mockModel.js";
import { components, initConvexTest } from "./setup.test.js";

type T = ReturnType<typeof initConvexTest>;

const city = z.object({ city: z.string() });
const tools = {
  weather: createTool({
    title: "Weather",
    metadata: { source: "mcp-weather" },
    inputSchema: city,
    execute: async () => "sunny",
  }),
  plain: createTool({ inputSchema: city, execute: async () => "plain" }),
  lookup: dynamicTool({
    title: "Lookup",
    metadata: { source: "mcp-lookup" },
    inputSchema: city,
    execute: async () => "found",
  }),
  web_search: tool({
    type: "provider",
    id: "test.web_search",
    args: {},
    isProviderExecuted: true,
    title: "Web search",
    metadata: { source: "provider" },
    inputSchema: city,
  }),
  ask: tool({ type: "dynamic", title: "Ask", inputSchema: city }),
} satisfies ToolSet;

const call = (toolCallId: string, toolName: string) =>
  ({
    type: "tool-call",
    toolCallId,
    toolName,
    input: JSON.stringify({ city: "Paris" }),
  }) satisfies LanguageModelV4Content;

const providerResult = (toolCallId: string, toolName: string) =>
  ({
    type: "tool-result",
    toolCallId,
    toolName,
    result: { hits: 1 },
  }) satisfies LanguageModelV4Content;

async function stream(t: T, steps: LanguageModelV4Content[][]) {
  return t.action(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, {});
    const agent = new Agent(components.agent, {
      name: "details",
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
    return { threadId, streamed: toolParts(streamed!.parts) };
  });
}

async function listed(t: T, threadId: string, numItems = 20) {
  const pages: ReturnType<typeof toolParts>[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result = await t.run((ctx) =>
      listUIMessages(ctx, components.agent, {
        threadId,
        paginationOpts: { cursor, numItems },
      }),
    );
    pages.push(toolParts(result.page.flatMap((message) => message.parts)));
    if (result.isDone) return pages;
    cursor = result.continueCursor;
  }
}

function toolParts(
  parts: readonly unknown[],
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    (parts as Record<string, unknown>[])
      .filter((part) => typeof part.toolCallId === "string")
      .map((part) => [
        part.toolCallId,
        Object.fromEntries(
          ["type", "toolName", "state", "title", "toolMetadata"]
            .filter((key) => key in part)
            .map((key) => [key, part[key]]),
        ),
      ]),
  );
}

describe("tool part details after reload", () => {
  test("a reloaded tool part matches the streamed one", async () => {
    const t = initConvexTest();
    const { threadId, streamed } = await stream(t, [
      [
        call("c-weather", "weather"),
        call("c-plain", "plain"),
        call("c-lookup", "lookup"),
        call("c-search", "web_search"),
        providerResult("c-search", "web_search"),
        {
          ...call("c-remote", "remote_mcp"),
          providerExecuted: true,
          dynamic: true,
        },
        { ...providerResult("c-remote", "remote_mcp"), dynamic: true },
      ],
      [{ type: "text", text: "It is sunny." }],
    ]);
    expect(streamed).toMatchObject({
      "c-weather": { type: "tool-weather", title: "Weather" },
      "c-plain": { type: "tool-plain", state: "output-available" },
      "c-lookup": { type: "dynamic-tool", toolName: "lookup", title: "Lookup" },
      "c-remote": { type: "dynamic-tool", toolName: "remote_mcp" },
    });
    const [reloaded] = await listed(t, threadId);
    expect(reloaded).toStrictEqual(streamed);
  });

  test("a dynamic tool's result on a later page reloads as the same part", async () => {
    const t = initConvexTest();
    const { threadId } = await stream(t, [
      [call("c-lookup", "lookup")],
      [{ type: "text", text: "Found it." }],
    ]);
    const pages = await listed(t, threadId, 1);
    const parts = pages.flatMap((page) => Object.values(page));
    expect(
      parts.sort((a, b) => String(a.state).localeCompare(String(b.state))),
    ).toMatchObject([
      { type: "dynamic-tool", toolName: "lookup", state: "input-available" },
      { type: "dynamic-tool", toolName: "lookup", state: "output-available" },
    ]);
  });

  test("a dynamic client tool's output on a later page reloads as the same part", async () => {
    const t = initConvexTest();
    const { threadId } = await stream(t, [[call("c-ask", "ask")]]);
    await t.run((ctx) =>
      new Agent(components.agent, {
        name: "details",
        tools,
        languageModel: mockModel(),
      }).addToolOutput(ctx, {
        threadId,
        tool: "ask",
        toolCallId: "c-ask",
        output: "Paris",
      }),
    );
    const pages = await listed(t, threadId, 1);
    expect(pages.flatMap((page) => Object.values(page))).toContainEqual({
      type: "dynamic-tool",
      toolName: "ask",
      state: "output-available",
    });
  });

  test("a step saved with per-call tools reloads as their part", async () => {
    const t = initConvexTest();
    const threadId = await t.action(async (ctx) => {
      const threadId = await createThread(ctx, components.agent, {});
      const agent = new Agent(components.agent, {
        name: "details",
        tools,
        languageModel: mockModel(),
      });
      const { messageId: promptMessageId } = await agent.saveMessage(ctx, {
        threadId,
        prompt: "Find Paris",
        skipEmbeddings: true,
      });
      const perCall = {
        lookup: tool({ inputSchema: city, execute: async () => "found" }),
      };
      const { steps } = await generateText({
        model: mockModel({ contentSteps: [[call("c-lookup", "lookup")]] }),
        tools: perCall,
        prompt: "Find Paris",
      });
      await agent.saveStep(ctx, {
        threadId,
        promptMessageId,
        step: steps[0],
        tools: perCall,
      });
      return threadId;
    });
    const [reloaded] = await listed(t, threadId);
    expect(reloaded["c-lookup"]).toStrictEqual({
      type: "tool-lookup",
      state: "output-available",
    });
  });

  test("a recovered stream keeps the tool part's details", () => {
    const docs = projectPersistedUIMessageChunks(
      {
        streamId: "stream-1",
        status: "aborted",
        format: "UIMessageChunk",
        order: 0,
        stepOrder: 0,
      },
      [
        {
          type: "tool-input-available",
          toolCallId: "c-lookup",
          toolName: "lookup",
          input: { city: "Paris" },
          dynamic: true,
          title: "Lookup",
          toolMetadata: { source: "mcp-lookup" },
        },
      ],
      { status: "failed", error: "aborted" },
    );
    const [message] = toUIMessages(
      docs.map(
        (doc, i) =>
          ({
            ...doc,
            _id: `msg-${i}`,
            _creationTime: 0,
            order: 0,
            stepOrder: i,
            threadId: "thread",
            tool: true,
          }) as MessageDoc,
      ),
    );
    expect(toolParts(message.parts)).toStrictEqual({
      "c-lookup": {
        type: "dynamic-tool",
        toolName: "lookup",
        state: "input-available",
        title: "Lookup",
        toolMetadata: { source: "mcp-lookup" },
      },
    });
  });
});
