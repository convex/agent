import { expect, test } from "vitest";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { tool } from "ai";
import { z } from "zod/v4";
import {
  Agent,
  createThread,
  createTool,
  deriveUIMessagesFromDeltas,
  listMessages,
  listUIMessages,
  toUIMessages,
} from "../index.js";
import { toModelMessage } from "../mapping.js";
import { app, components } from "./setup.test.js";
import { mockModel } from "./mockModel.js";

const schema = { $ref: "#/$defs/item" };
const paginationOpts = { cursor: null, numItems: 20 };
const callTool = (toolName: string) =>
  mockModel({
    contentSteps: [
      [
        {
          type: "tool-call",
          toolCallId: "call",
          toolName,
          input: JSON.stringify(schema),
        },
      ],
    ],
  });

const { createTest, api } = app.defineModules({
  toolJson: {
    list: app.query({
      args: { threadId: v.string(), paginationOpts: paginationOptsValidator },
      handler: (ctx, args) => listUIMessages(ctx, components.agent, args),
    }),
    generate: app.action({
      args: { threadId: v.string(), saveStreamDeltas: v.boolean() },
      handler: async (ctx, { threadId, saveStreamDeltas }) => {
        const agent = new Agent(components.agent, {
          name: "tool-json",
          languageModel: callTool("schema"),
          tools: {
            schema: createTool({
              inputSchema: z.record(z.string(), z.string()),
              execute: async () => schema,
            }),
          },
        });
        const result = await agent.streamText(
          ctx,
          { threadId },
          { prompt: "Read this schema" },
          { saveStreamDeltas },
        );
        await result.consumeStream();
      },
    }),
    clientTool: app.action({
      args: { threadId: v.string() },
      handler: async (ctx, { threadId }) => {
        const agent = new Agent(components.agent, {
          name: "client-tool-json",
          languageModel: callTool("pick"),
          tools: {
            pick: tool({ inputSchema: z.record(z.string(), z.string()) }),
          },
        });
        await agent.generateText(ctx, { threadId }, { prompt: "Pick one" });
        await ctx.runMutation(api.toolJson.addOutput, { threadId });
      },
    }),
    addOutput: app.mutation({
      args: { threadId: v.string() },
      handler: async (ctx, { threadId }) => {
        const agent = new Agent(components.agent, {
          name: "client-tool-json",
          languageModel: mockModel({}),
          tools: {
            pick: tool({ inputSchema: z.record(z.string(), z.string()) }),
          },
        });
        await agent.addToolOutput(ctx, {
          threadId,
          tool: "pick",
          toolCallId: "call",
          output: schema,
        });
      },
    }),
  },
});

async function storedToolParts(
  t: ReturnType<typeof createTest>,
  threadId: string,
) {
  const { page } = await t.run((ctx) =>
    listMessages(ctx, components.agent, {
      threadId,
      paginationOpts,
      excludeToolMessages: false,
    }),
  );
  return {
    page,
    parts: page.flatMap((doc): unknown[] => {
      const { content } = toModelMessage(doc.message!);
      return typeof content === "string" ? [] : content;
    }),
  };
}

const call = expect.objectContaining({ type: "tool-call", input: schema });
const result = expect.objectContaining({
  type: "tool-result",
  output: { type: "json", value: schema },
});

test("streams a tool result with a $ref key through deltas", async () => {
  const t = createTest();
  const threadId = await t.run((ctx) =>
    createThread(ctx, components.agent, {}),
  );
  await t.action(api.toolJson.generate, { threadId, saveStreamDeltas: true });
  const streams = await t.query(components.agent.streams.list, {
    threadId,
    statuses: ["finished"],
  });
  const deltas = await t.query(components.agent.streams.listDeltas, {
    threadId,
    cursors: streams.map(({ streamId }) => ({ streamId, cursor: 0 })),
  });
  const messages = await deriveUIMessagesFromDeltas(threadId, streams, deltas);
  expect(messages.flatMap(({ parts }) => parts)).toContainEqual(
    expect.objectContaining({
      type: "tool-schema",
      input: schema,
      output: schema,
    }),
  );
});

test("saves a client tool output with a $ref key", async () => {
  const t = createTest();
  const threadId = await t.run((ctx) =>
    createThread(ctx, components.agent, {}),
  );
  await t.action(api.toolJson.clientTool, { threadId });
  const { parts } = await storedToolParts(t, threadId);
  expect(parts).toEqual(expect.arrayContaining([call, result]));
});

test("reads tool JSON back parsed from toUIMessages and as text from listUIMessages", async () => {
  const t = createTest();
  const threadId = await t.run((ctx) =>
    createThread(ctx, components.agent, {}),
  );
  await t.action(api.toolJson.generate, { threadId, saveStreamDeltas: false });
  const { page } = await storedToolParts(t, threadId);
  const tool = { type: "tool-schema", input: schema, output: schema };
  expect(toUIMessages(page).flatMap(({ parts }) => parts)).toContainEqual(
    expect.objectContaining(tool),
  );
  // A query can't return `$` keys, so it returns the text; useUIMessages
  // parses it.
  const ui = await t.query(api.toolJson.list, { threadId, paginationOpts });
  expect(ui.page.flatMap(({ parts }) => parts)).toContainEqual(
    expect.objectContaining({
      input: JSON.stringify(schema),
      output: JSON.stringify(schema),
      toolJson: { input: true, output: true },
    }),
  );
});

test("reads a row saved before encoding as it is", async () => {
  const t = createTest();
  const threadId = await t.run((ctx) =>
    createThread(ctx, components.agent, {}),
  );
  const text = JSON.stringify(schema);
  await t.mutation(components.agent.messages.addMessages, {
    threadId,
    messages: [
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "t",
              toolCallId: "c",
              input: text,
              args: text,
            },
          ],
        },
      },
      {
        message: {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "t",
              toolCallId: "c",
              output: { type: "json", value: text },
            },
          ],
        },
      },
    ],
  });
  const { parts } = await storedToolParts(t, threadId);
  expect(parts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "tool-call", input: text }),
      expect.objectContaining({ output: { type: "json", value: text } }),
    ]),
  );
});
