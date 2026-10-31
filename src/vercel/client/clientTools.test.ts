import { describe, expect, test } from "vitest";
import { v } from "convex/values";
import { stepCountIs } from "ai";
import { z } from "zod/v4";
import {
  Agent,
  createTool,
  listMessages,
  listUIMessages,
  saveMessage,
} from "../index.js";
import { app, components } from "./setup.test.js";
import { mockModel, type MockLanguageModel } from "./mockModel.js";

const getLocation = createTool({
  description: "Get the user's location from their browser",
  inputSchema: z.object({ precise: z.boolean() }),
});

const executed: string[] = [];
const deleteFile = createTool({
  inputSchema: z.object({ filename: z.string() }),
  needsApproval: true,
  execute: async (_ctx, { filename }) => {
    executed.push(filename);
    return `Deleted ${filename}`;
  },
});

const confirmLocation = createTool({
  inputSchema: z.object({ precise: z.boolean() }),
  needsApproval: true,
});

const tools = { getLocation, deleteFile, confirmLocation };
const callIds: Record<string, string> = {
  getLocation: "tc-client",
  deleteFile: "tc-delete",
  confirmLocation: "tc-confirm",
};

const models = new Map<string, MockLanguageModel>();
function agentFor(name: string, toolNames = ["getLocation"]) {
  let model = models.get(name);
  if (!model) {
    model = mockModel({
      contentSteps: [
        toolNames.map((toolName) => ({
          type: "tool-call" as const,
          toolCallId: callIds[toolName],
          toolName,
          input: JSON.stringify(
            toolName === "deleteFile"
              ? { filename: "a.txt" }
              : { precise: true },
          ),
        })),
        [{ type: "text", text: "You are in Paris." }],
      ],
    }) as MockLanguageModel;
    models.set(name, model);
  }
  return new Agent(components.agent, {
    name,
    tools,
    languageModel: model,
    stopWhen: stepCountIs(5),
  });
}

const start = app.action({
  args: {
    name: v.string(),
    stream: v.boolean(),
    toolNames: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { name, stream, toolNames }) => {
    const agent = agentFor(name, toolNames);
    const { threadId } = await agent.createThread(ctx, {});
    if (stream) {
      const result = await agent.streamText(
        ctx,
        { threadId },
        { prompt: "Where am I?" },
        { saveStreamDeltas: { chunking: "word", throttleMs: 0 } },
      );
      await result.consumeStream();
    } else {
      await agent.generateText(ctx, { threadId }, { prompt: "Where am I?" });
    }
    return threadId;
  },
});

const cont = app.action({
  args: {
    name: v.string(),
    threadId: v.string(),
    promptMessageId: v.string(),
    stream: v.boolean(),
  },
  handler: async (ctx, { name, threadId, promptMessageId, stream }) => {
    const agent = agentFor(name);
    let text: string;
    if (stream) {
      const result = await agent.streamText(
        ctx,
        { threadId },
        { promptMessageId },
        { saveStreamDeltas: { chunking: "word", throttleMs: 0 } },
      );
      await result.consumeStream();
      text = await result.text;
    } else {
      text = (await agent.generateText(ctx, { threadId }, { promptMessageId }))
        .text;
    }
    const model = models.get(name)!;
    const calls = stream ? model.doStreamCalls : model.doGenerateCalls;
    return { text, prompt: JSON.parse(JSON.stringify(calls.at(-1)!.prompt)) };
  },
});

const addOutput = app.mutation({
  args: {
    threadId: v.string(),
    tool: v.optional(v.string()),
    toolCallId: v.string(),
    output: v.optional(v.any()),
    errorText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { threadId, toolCallId, output, errorText } = args;
    const tool = args.tool ?? "getLocation";
    const agent = agentFor("mutations");
    return errorText === undefined
      ? agent.addToolOutput(ctx, { threadId, tool, toolCallId, output })
      : agent.addToolOutput(ctx, {
          threadId,
          tool,
          toolCallId,
          state: "output-error",
          errorText,
        });
  },
});

const decide = app.mutation({
  args: { threadId: v.string(), approved: v.boolean() },
  handler: async (ctx, { threadId, approved }) => {
    const agent = agentFor("mutations");
    const { page } = await listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    const request = page
      .flatMap((m) =>
        m.message?.role === "assistant" && Array.isArray(m.message.content)
          ? m.message.content
          : [],
      )
      .find((p) => p.type === "tool-approval-request");
    const approvalId = (request as { approvalId: string }).approvalId;
    return approved
      ? agent.approveToolCall(ctx, { threadId, approvalId })
      : agent.denyToolCall(ctx, { threadId, approvalId });
  },
});

const saveProviderCall = app.mutation({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) =>
    saveMessage(ctx, components.agent, {
      threadId,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-provider",
            toolName: "web_search",
            input: {},
            providerExecuted: true,
          },
        ],
      },
    }),
});

const saveUserMessage = app.mutation({
  args: { threadId: v.string(), prompt: v.string() },
  handler: async (ctx, { threadId, prompt }) =>
    saveMessage(ctx, components.agent, { threadId, prompt }),
});

const messages = app.query({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const { page } = await listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 50 },
    });
    const ui = await listUIMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 50 },
    });
    return {
      docs: page.map((m) => ({ _id: m._id, order: m.order })),
      toolParts: ui.page
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "tool-getLocation"),
    };
  },
});

const { api, createTest } = app.defineModules({
  clientTools: {
    start,
    cont,
    addOutput,
    decide,
    saveProviderCall,
    saveUserMessage,
    messages,
  },
});

function promptRoles(prompt: any[]) {
  return prompt
    .filter((m) => m.role !== "system")
    .map((m) =>
      [
        m.role,
        ...(Array.isArray(m.content) ? m.content.map((p: any) => p.type) : []),
      ].join(":"),
    );
}

describe("addToolOutput", () => {
  test("createTool without execute or outputSchema defines a client tool", () => {
    expect(getLocation.execute).toBeUndefined();
  });

  for (const stream of [false, true]) {
    const mode = stream ? "streamText" : "generateText";

    test(`${mode}: the output is saved next to its call and the continuation sees call then result`, async () => {
      const t = createTest();
      const name = `order-${mode}`;
      const threadId = await t.action(api.clientTools.start, { name, stream });
      const before = await t.query(api.clientTools.messages, { threadId });
      expect(before.toolParts).toEqual([
        expect.objectContaining({
          toolCallId: "tc-client",
          state: "input-available",
          input: { precise: true },
        }),
      ]);
      const callOrder = before.docs[0].order;
      await t.mutation(api.clientTools.saveUserMessage, {
        threadId,
        prompt: "in between",
      });

      const { messageId } = await t.mutation(api.clientTools.addOutput, {
        threadId,
        toolCallId: "tc-client",
        output: { city: "Paris" },
      });
      const after = await t.query(api.clientTools.messages, { threadId });
      expect(after.docs.find((m) => m._id === messageId)?.order).toBe(
        callOrder,
      );
      expect(after.toolParts).toEqual([
        expect.objectContaining({
          state: "output-available",
          output: { city: "Paris" },
        }),
      ]);

      const next = await t.action(api.clientTools.cont, {
        name,
        threadId,
        promptMessageId: messageId,
        stream,
      });
      expect(next.text).toBe("You are in Paris.");
      expect(promptRoles(next.prompt)).toEqual([
        "user:text",
        "assistant:tool-call",
        "tool:tool-result",
      ]);
      expect(next.prompt.at(-1).content[0]).toMatchObject({
        toolCallId: "tc-client",
        toolName: "getLocation",
        output: { type: "json", value: { city: "Paris" } },
      });
    });
  }

  test("errorText saves an error result the model sees", async () => {
    const t = createTest();
    const name = "error-text";
    const threadId = await t.action(api.clientTools.start, {
      name,
      stream: false,
    });
    const { messageId } = await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client",
      errorText: "Permission denied",
    });
    const after = await t.query(api.clientTools.messages, { threadId });
    expect(after.toolParts).toEqual([
      expect.objectContaining({
        state: "output-error",
        errorText: "Permission denied",
      }),
    ]);
    const next = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: messageId,
      stream: false,
    });
    expect(next.prompt.at(-1).content[0]).toMatchObject({
      toolCallId: "tc-client",
      output: { type: "error-text", value: "Permission denied" },
    });
  });

  test("a second output for the same call is rejected", async () => {
    const t = createTest();
    const threadId = await t.action(api.clientTools.start, {
      name: "twice",
      stream: false,
    });
    await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client",
      output: { city: "Paris" },
    });
    await expect(
      t.mutation(api.clientTools.addOutput, {
        threadId,
        toolCallId: "tc-client",
        output: { city: "Rome" },
      }),
    ).rejects.toThrow(/Tool call tc-client was already handled/);
  });

  test("an output after a denial is rejected", async () => {
    const t = createTest();
    const threadId = await t.action(api.clientTools.start, {
      name: "after-denial",
      stream: false,
      toolNames: ["confirmLocation"],
    });
    await t.mutation(api.clientTools.decide, { threadId, approved: false });
    await expect(
      t.mutation(api.clientTools.addOutput, {
        threadId,
        tool: "confirmLocation",
        toolCallId: "tc-confirm",
        output: { city: "Paris" },
      }),
    ).rejects.toThrow(/Tool call tc-confirm was already handled/);
  });

  test("an output for an approved server tool is rejected", async () => {
    const t = createTest();
    const threadId = await t.action(api.clientTools.start, {
      name: "server-tool",
      stream: false,
      toolNames: ["deleteFile"],
    });
    await t.mutation(api.clientTools.decide, { threadId, approved: true });
    await expect(
      t.mutation(api.clientTools.addOutput, {
        threadId,
        tool: "deleteFile",
        toolCallId: "tc-delete",
        output: "done",
      }),
    ).rejects.toThrow(/Tool deleteFile runs on the server/);
    await expect(
      t.mutation(api.clientTools.addOutput, {
        threadId,
        tool: "getLocation",
        toolCallId: "tc-delete",
        output: "done",
      }),
    ).rejects.toThrow(
      /Tool call tc-delete is a call to deleteFile, not getLocation/,
    );
  });

  for (const approved of [true, false]) {
    for (const outputFirst of [false, true]) {
      test(`a step with a client call and ${approved ? "an approved" : "a denied"} call continues from the ${outputFirst ? "decision" : "output"}`, async () => {
        const t = createTest();
        const name = `mixed-${approved}-${outputFirst}`;
        const threadId = await t.action(api.clientTools.start, {
          name,
          stream: false,
          toolNames: ["getLocation", "deleteFile"],
        });
        const output = () =>
          t.mutation(api.clientTools.addOutput, {
            threadId,
            toolCallId: "tc-client",
            output: { city: "Paris" },
          });
        const decision = () =>
          t.mutation(api.clientTools.decide, { threadId, approved });
        const { messageId } = outputFirst
          ? (await output(), await decision())
          : (await decision(), await output());
        executed.length = 0;

        const next = await t.action(api.clientTools.cont, {
          name,
          threadId,
          promptMessageId: messageId,
          stream: false,
        });
        expect(next.text).toBe("You are in Paris.");
        expect(executed).toEqual(approved ? ["a.txt"] : []);
        const results = next.prompt
          .filter((m: any) => m.role === "tool")
          .flatMap((m: any) => m.content)
          .filter((p: any) => p.type === "tool-result");
        expect(results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              toolCallId: "tc-client",
              output: { type: "json", value: { city: "Paris" } },
            }),
            expect.objectContaining({
              toolCallId: "tc-delete",
              output: approved
                ? { type: "text", value: "Deleted a.txt" }
                : expect.objectContaining({ type: "execution-denied" }),
            }),
          ]),
        );
      });
    }
  }

  test("an approved client tool accepts its output", async () => {
    const t = createTest();
    const name = "approved-client";
    const threadId = await t.action(api.clientTools.start, {
      name,
      stream: false,
      toolNames: ["confirmLocation"],
    });
    await t.mutation(api.clientTools.decide, { threadId, approved: true });
    const { messageId } = await t.mutation(api.clientTools.addOutput, {
      threadId,
      tool: "confirmLocation",
      toolCallId: "tc-confirm",
      output: { city: "Paris" },
    });
    const next = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: messageId,
      stream: false,
    });
    expect(next.text).toBe("You are in Paris.");
    expect(next.prompt.at(-1).content).toContainEqual(
      expect.objectContaining({
        toolCallId: "tc-confirm",
        output: { type: "json", value: { city: "Paris" } },
      }),
    );
  });

  test("an output for a call awaiting approval is rejected", async () => {
    const t = createTest();
    const threadId = await t.action(api.clientTools.start, {
      name: "awaiting",
      stream: false,
      toolNames: ["confirmLocation"],
    });
    await expect(
      t.mutation(api.clientTools.addOutput, {
        threadId,
        tool: "confirmLocation",
        toolCallId: "tc-confirm",
        output: { city: "Paris" },
      }),
    ).rejects.toThrow(/Tool call tc-confirm is awaiting approval/);
  });

  test("an output for a provider-executed call is rejected", async () => {
    const t = createTest();
    const threadId = await t.action(api.clientTools.start, {
      name: "provider",
      stream: false,
    });
    await t.mutation(api.clientTools.saveProviderCall, { threadId });
    await expect(
      t.mutation(api.clientTools.addOutput, {
        threadId,
        tool: "web_search",
        toolCallId: "tc-provider",
        output: {},
      }),
    ).rejects.toThrow(/Tool call tc-provider is provider-executed/);
  });

  test("an unknown toolCallId is rejected", async () => {
    const t = createTest();
    const threadId = await t.action(api.clientTools.start, {
      name: "unknown",
      stream: false,
    });
    await expect(
      t.mutation(api.clientTools.addOutput, {
        threadId,
        toolCallId: "nope",
        output: {},
      }),
    ).rejects.toThrow(/Tool call nope was not found in the last 100 messages/);
  });
});
