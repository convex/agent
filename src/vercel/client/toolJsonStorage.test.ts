import { expect, test } from "vitest";
import { convexToJson, v, type Value } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { z } from "zod/v4";
import {
  Agent,
  createThread,
  createTool,
  decodeUIMessageToolJson,
  listUIMessages,
} from "../index.js";
import { saveMessages as saveCanonicalMessages } from "../../client/messages.js";
import { projectPersistedUIMessageChunks } from "../../streaming/materializePersistedUIMessageChunks.js";
import { mergeUIMessages } from "../react/useUIMessages.js";
import { deriveUIMessagesFromDeltas } from "../deltas.js";
import { serializeOrThrow, toModelMessage } from "../mapping.js";
import { app, components } from "./setup.test.js";
import { mockModel } from "./mockModel.js";

const schema = { $ref: "#/$defs/item" };
const plain = { ref: "#/definitions/item" };

const paginationOpts = { cursor: null, numItems: 20 };

const { createTest, api } = app.defineModules({
  toolJsonStorage: {
    list: app.query({
      args: { threadId: v.string(), paginationOpts: paginationOptsValidator },
      handler: (ctx, args) => listUIMessages(ctx, components.agent, args),
    }),
    generate: app.action({
      args: {
        threadId: v.string(),
        saveStreamDeltas: v.boolean(),
        reservedInput: v.boolean(),
        reservedOutput: v.boolean(),
      },
      handler: async (ctx, args) => {
        const agent = new Agent(components.agent, {
          name: "tool-json-storage",
          languageModel: mockModel({
            contentSteps: [
              [
                {
                  type: "tool-call",
                  toolCallId: "schema-call",
                  toolName: "schema",
                  input: JSON.stringify(args.reservedInput ? schema : plain),
                },
              ],
            ],
          }),
          tools: {
            schema: createTool({
              inputSchema: z.record(z.string(), z.string()),
              execute: async () => (args.reservedOutput ? schema : plain),
            }),
          },
        });

        const result = await agent.streamText(
          ctx,
          { threadId: args.threadId },
          { prompt: "Read this schema" },
          { saveStreamDeltas: args.saveStreamDeltas },
        );
        if (!args.saveStreamDeltas) await result.consumeStream();
      },
    }),
  },
});

test.each([
  {
    name: "ordinary JSON",
    saveStreamDeltas: true,
    reservedInput: false,
    reservedOutput: false,
  },
  {
    name: "JSON Schema result",
    saveStreamDeltas: false,
    reservedInput: false,
    reservedOutput: true,
  },
  {
    name: "streamed JSON Schema result",
    saveStreamDeltas: true,
    reservedInput: false,
    reservedOutput: true,
  },
  {
    name: "streamed JSON Schema input",
    saveStreamDeltas: true,
    reservedInput: true,
    reservedOutput: false,
  },
])("round trips $name", async ({ name: _name, ...args }) => {
  const t = createTest();
  const threadId = await t.run((ctx) =>
    createThread(ctx, components.agent, {}),
  );
  await t.action(api.toolJsonStorage.generate, { threadId, ...args });

  const input = args.reservedInput ? schema : plain;
  const output = args.reservedOutput ? schema : plain;
  const { page } = await t.query(
    components.agent.messages.listMessagesByThreadId,
    {
      threadId,
      order: "asc",
      paginationOpts,
    },
  );
  const parts = page.flatMap(({ message }) => {
    const model = message && toModelMessage(message);
    return model && Array.isArray(model.content) ? [...model.content] : [];
  });
  expect.soft(parts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "tool-call", input }),
      expect.objectContaining({
        type: "tool-result",
        output: { type: "json", value: output },
      }),
    ]),
  );

  const ui = await t.query(api.toolJsonStorage.list, {
    threadId,
    paginationOpts,
  });
  const uiTool = expect.objectContaining({
    type: "tool-schema",
    state: "output-available",
    input,
    output,
  });
  expect(
    ui.page.map(decodeUIMessageToolJson).flatMap(({ parts }) => parts),
  ).toContainEqual(uiTool);
  expect(
    mergeUIMessages(ui.page, []).flatMap(({ parts }) => parts),
  ).toContainEqual(uiTool);
  if (!args.reservedInput && !args.reservedOutput) {
    const raw = ui.page
      .flatMap(({ parts }) => parts)
      .find(({ type }) => type === "tool-schema");
    expect(raw).toMatchObject({ input: plain, output: plain });
    expect(raw).not.toHaveProperty("toolJson");
  }

  if (args.saveStreamDeltas) {
    const streams = await t.query(components.agent.streams.list, {
      threadId,
      statuses: ["streaming", "finished", "aborted"],
    });
    expect(streams).toEqual([expect.objectContaining({ status: "finished" })]);
    const deltas = await t.query(components.agent.streams.listDeltas, {
      threadId,
      cursors: streams.map(({ streamId }) => ({ streamId, cursor: 0 })),
    });
    const messages = await deriveUIMessagesFromDeltas(
      threadId,
      streams,
      deltas,
    );
    expect(messages.flatMap((message) => message.parts)).toContainEqual(uiTool);
    const projected = projectPersistedUIMessageChunks(
      streams[0],
      deltas.flatMap(({ parts }) => parts),
      { status: "success" },
    );
    const modelParts = projected.flatMap(({ message }) => {
      const model = toModelMessage(message);
      return Array.isArray(model.content) ? [...model.content] : [];
    });
    expect(modelParts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool-call", input }),
        expect.objectContaining({
          type: "tool-result",
          output: { type: "json", value: output },
        }),
      ]),
    );
    expect(() => convexToJson(projected as Value)).not.toThrow();
  }
});

test("reads historical args and a string result without interpreting it as encoded JSON", async () => {
  const t = createTest();
  const threadId = await t.run((ctx) =>
    createThread(ctx, components.agent, {}),
  );
  const payload = JSON.stringify(schema);
  await t.run((ctx) =>
    saveCanonicalMessages(ctx, components.agent, {
      threadId,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "schema",
              toolCallId: "legacy",
              args: payload,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "schema",
              toolCallId: "legacy",
              result: payload,
            },
          ],
        },
      ],
    }),
  );
  const { page } = await t.query(api.toolJsonStorage.list, {
    threadId,
    paginationOpts,
  });
  const raw = page
    .flatMap(({ parts }) => parts)
    .find(({ type }) => type === "tool-schema");
  expect(raw).toMatchObject({ input: payload, output: payload });
  expect(raw).not.toHaveProperty("toolJson");
  expect(page.map(decodeUIMessageToolJson)).toEqual(page);
});

test("round trips error JSON without changing provider options or negative zero", async () => {
  const message = {
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolName: "schema",
        toolCallId: "schema-error",
        output: {
          type: "error-json" as const,
          value: { nested: [schema, { offset: -0 }] },
          providerOptions: { test: { retryable: true } },
        },
      },
    ],
  };
  const stored = await serializeOrThrow(message);
  expect(() => convexToJson(stored as Value)).not.toThrow();
  expect(toModelMessage(stored)).toMatchObject(message);
});
