import { describe, expect, test } from "vitest";
import {
  Agent,
  createThread,
  createTool,
  filterOutOrphanedToolMessages,
  saveMessage,
  toUIMessages,
  type MessageDoc,
} from "../index.js";
import { v } from "convex/values";
import { stepCountIs } from "ai";
import { app, components } from "./setup.test.js";
import { z } from "zod/v4";
import { MockLanguageModel, mockModel } from "./mockModel.js";

const TEST_TEXT = JSON.stringify({ hello: "world" });

const agentModel = new MockLanguageModel({
  content: [{ type: "text", text: TEST_TEXT }],
});
const agent = new Agent(components.agent, {
  name: "test",
  instructions: "You are a test agent",
  languageModel: agentModel,
});

let capturedRawBodies: { request?: unknown; response?: unknown } | undefined;
const rawBodyAgent = new Agent(components.agent, {
  name: "raw-body-test",
  languageModel: mockModel({
    doGenerate: async () => ({
      content: [{ type: "text", text: "raw" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      request: { body: { prompt: "request-body" } },
      response: { body: { text: "response-body" }, headers: {} },
      warnings: [],
    }),
  }),
  rawRequestResponseHandler: async (_ctx, event) => {
    capturedRawBodies = {
      request: event.request.body,
      response: event.response.body,
    };
  },
});

const captureRawBodies = app.action({
  args: {},
  handler: async (ctx) => {
    capturedRawBodies = undefined;
    await rawBodyAgent.generateText(
      ctx,
      { userId: "raw-body-user" },
      { prompt: "raw" },
    );
    return capturedRawBodies;
  },
});

const testQuery = app.query({
  args: { threadId: v.string() },
  handler: async (ctx, args) => {
    return await agent.listMessages(ctx, {
      threadId: args.threadId,
      paginationOpts: { cursor: null, numItems: 10 },
      excludeToolMessages: true,
      statuses: ["success"],
    });
  },
});

const createThreadManually = app.mutation({
  args: {},
  handler: async (ctx) => {
    const { threadId } = await agent.createThread(ctx, { userId: "1" });
    return { threadId };
  },
});

const saveStepAgent = new Agent(components.agent, {
  name: "save-step-test",
  instructions: "test",
  tools: {
    echo: createTool({
      description: "Echo a value",
      inputSchema: z.object({ value: z.string() }),
      execute: async (_ctx, input) => `echo:${input.value}`,
    }),
  },
  languageModel: mockModel({
    contentSteps: [
      [
        {
          type: "tool-call",
          toolCallId: "ss-1",
          toolName: "echo",
          input: JSON.stringify({ value: "hi" }),
        },
      ],
      [{ type: "text", text: "done" }],
    ],
  }),
  stopWhen: stepCountIs(5),
});

const replayStepsViaSaveStep = app.action({
  args: { withPreviousStep: v.boolean() },
  handler: async (ctx, args) => {
    const { thread } = await saveStepAgent.createThread(ctx, {
      userId: "ss-gen",
    });
    const genResult = await thread.generateText({ prompt: "echo hi" });
    const steps = genResult.steps;

    const { threadId } = await saveStepAgent.createThread(ctx, {
      userId: "ss-replay",
    });
    const { messageId: promptMessageId } = await saveStepAgent.saveMessage(
      ctx,
      {
        threadId,
        message: { role: "user", content: "echo hi" },
        skipEmbeddings: true,
      },
    );
    let previousStep: (typeof steps)[number] | undefined;
    for (const step of steps) {
      await saveStepAgent.saveStep(ctx, {
        threadId,
        promptMessageId,
        step,
        previousStep: args.withPreviousStep ? previousStep : undefined,
      });
      previousStep = step;
    }

    const replayed = await saveStepAgent.listMessages(ctx, {
      threadId,
      paginationOpts: { cursor: null, numItems: 50 },
      statuses: ["success", "pending", "failed"],
    });
    const contentTypes = replayed.page.flatMap((m) =>
      Array.isArray(m.message?.content)
        ? m.message!.content.map((c: { type?: string }) => c.type ?? "text")
        : ["text"],
    );
    return { stepCount: steps.length, contentTypes };
  },
});

const createThreadMutation = agent.createThreadMutation();
const generateObjectAction = agent.asObjectAction({
  schema: z.object({ hello: z.string().describe("A string for testing") }),
});
const generateTextAction = agent.asTextAction({});
const streamTextAction = agent.asTextAction({ stream: true });
const saveMessageMutation = agent.asSaveMessagesMutation();

const createAndGenerate = app.action({
  args: {},
  handler: async (ctx) => {
    const { thread } = await agent.createThread(ctx, { userId: "1" });
    const result = await thread.generateText({
      messages: [{ role: "user", content: "Hello" }],
    });
    return result.text;
  },
});

const continueThreadAction = app.action({
  args: { threadId: v.string(), userId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { thread } = await agent.continueThread(ctx, args);
    return { threadId: thread.threadId };
  },
});

const generateTextWithThread = app.action({
  args: {
    threadId: v.string(),
    userId: v.optional(v.string()),
    messages: v.array(v.any()),
    contextOptions: v.optional(v.any()),
    storageOptions: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const { thread } = await agent.continueThread(ctx, {
      threadId: args.threadId,
      userId: args.userId,
    });
    const result = await thread.generateText(
      { messages: args.messages },
      {
        contextOptions: args.contextOptions,
        storageOptions: args.storageOptions,
      },
    );
    return { text: result.text };
  },
});

const generateObjectWithThread = app.action({
  args: {
    threadId: v.string(),
    userId: v.optional(v.string()),
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    const { thread } = await agent.continueThread(ctx, {
      threadId: args.threadId,
      userId: args.userId,
    });
    const result = await thread.generateObject({
      prompt: args.prompt,
      schema: z.object({ hello: z.string() }),
    });
    return { object: result.object };
  },
});

const fetchContextAction = app.action({
  args: {
    userId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    messages: v.array(v.any()),
    contextOptions: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const context = await agent.fetchContextMessages(ctx, {
      userId: args.userId,
      threadId: args.threadId,
      messages: args.messages,
      contextOptions: args.contextOptions,
    });
    return context;
  },
});

const { api, internal, createTest } = app.defineModules({
  index: {
    captureRawBodies,
    testQuery,
    createThreadManually,
    replayStepsViaSaveStep,
    createThreadMutation,
    generateObjectAction,
    generateTextAction,
    streamTextAction,
    saveMessageMutation,
    createAndGenerate,
    continueThreadAction,
    generateTextWithThread,
    generateObjectWithThread,
    fetchContextAction,
  },
});

describe("Agent thick client", () => {
  test("should create a thread", async () => {
    const t = createTest();
    const result = await t.mutation(api.index.createThreadManually, {});
    expect(result.threadId).toBeTypeOf("string");
  });
  test("should create a thread and generate text", async () => {
    const t = createTest();
    const result = await t.action(api.index.createAndGenerate, {});
    expect(result).toBeDefined();
    expect(result).toMatch(TEST_TEXT);
  });
  test.each([true, false])(
    "saveStep persists each SDK 7 step once (previousStep: %s)",
    async (withPreviousStep) => {
      const t = createTest();
      const res = await t.action(api.index.replayStepsViaSaveStep, {
        withPreviousStep,
      });
      expect(res.stepCount).toBe(2);
      const toolCalls = res.contentTypes.filter(
        (t) => t === "tool-call",
      ).length;
      const toolResults = res.contentTypes.filter(
        (t) => t === "tool-result",
      ).length;
      expect({ toolCalls, toolResults }).toEqual({
        toolCalls: 1,
        toolResults: 1,
      });
    },
  );
});

describe("filterOutOrphanedToolMessages", () => {
  const call1: MessageDoc = {
    _id: "call1",
    _creationTime: Date.now(),
    order: 1,
    stepOrder: 1,
    tool: true,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "1",
          toolName: "tool1",
          input: { test: "test" },
          args: { test: "test" },
        },
      ],
    },
    status: "success",
    threadId: "1",
  };
  const response1: MessageDoc = {
    _id: "response1",
    _creationTime: Date.now(),
    order: 1,
    stepOrder: 1,
    tool: true,
    message: {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "1",
          toolName: "tool1",
          result: { test: "test" },
        },
      ],
    },
    status: "success",
    threadId: "1",
  };
  const call2: MessageDoc = {
    _id: "call2",
    _creationTime: Date.now(),
    order: 1,
    stepOrder: 2,
    tool: true,
    message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    status: "success",
    threadId: "1",
  };
  test("should not filter out extra tool calls", () => {
    expect(filterOutOrphanedToolMessages([call1, response1, call2])).toEqual([
      call1,
      response1,
      call2,
    ]);
  });
  test("should filter out extra tool calls", () => {
    expect(filterOutOrphanedToolMessages([response1, call2])).toEqual([call2]);
  });
});

describe("Agent option variations and normal behavior", () => {
  test("raw handler opts into retained SDK 7 request and response bodies", async () => {
    const t = createTest();
    await expect(t.action(api.index.captureRawBodies, {})).resolves.toEqual({
      request: { prompt: "request-body" },
      response: { text: "response-body" },
    });
  });

  test("Agent can be constructed with minimal options", () => {
    const a = new Agent(components.agent, {
      name: "minimal",
      languageModel: mockModel(),
    });
    expect(a).toBeInstanceOf(Agent);
  });

  test("Agent can be constructed with all options", () => {
    const a = new Agent(components.agent, {
      name: "full",
      languageModel: mockModel(),
      instructions: "Test instructions",
      contextOptions: { recentMessages: 5 },
      storageOptions: { saveMessages: "all" },
      stopWhen: stepCountIs(2),
      callSettings: { maxRetries: 1 },
      usageHandler: async () => {},
      rawRequestResponseHandler: async () => {},
    });
    expect(a.options.name).toBe("full");
  });
});

describe("Agent thread management", () => {
  test("createThread returns threadId (mutation context)", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "2" }),
    );
    expect(threadId).toBeTypeOf("string");
  });

  test("continueThread returns thread object", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "3" }),
    );
    const result = await t.action(api.index.continueThreadAction, {
      threadId,
      userId: "3",
    });
    expect(result.threadId).toBe(threadId);
  });
});

describe("Agent message operations", () => {
  test("saveMessage and saveMessages store messages", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "4" }),
    );
    const { messageId } = await t.run(async (ctx) =>
      agent.saveMessage(ctx, {
        threadId,
        userId: "4",
        message: { role: "user", content: "Hello" },
      }),
    );
    expect(messageId).toBeTypeOf("string");

    const { messages } = await t.run(async (ctx) =>
      agent.saveMessages(ctx, {
        threadId,
        userId: "4",
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello!" },
        ],
      }),
    );
    expect(messages.length).toBe(2);
    expect(messages[1]._id).toBeDefined();
  });

  test("saveMessage can place a standalone assistant message on a new order", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "operator-test" }),
    );
    const { message: agentReply } = await t.run(async (ctx) =>
      agent.saveMessage(ctx, {
        threadId,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "handoff-1",
              toolName: "handoff",
              input: {},
            },
          ],
        },
      }),
    );
    const { message: operatorReply } = await t.run(async (ctx) =>
      saveMessage(ctx, components.agent, {
        threadId,
        order: "next",
        agentName: "human:Alex",
        message: { role: "assistant", content: "Operator reply" },
      }),
    );
    const uiMessages = toUIMessages([agentReply, operatorReply]);

    expect(agentReply).toMatchObject({ order: 0, stepOrder: 0 });
    expect(operatorReply).toMatchObject({
      order: 1,
      stepOrder: 0,
      agentName: "human:Alex",
    });
    expect(uiMessages).toHaveLength(2);
    expect(uiMessages[1]).toMatchObject({
      order: 1,
      agentName: "human:Alex",
      text: "Operator reply",
    });
  });
});

describe("Agent text/object generation", () => {
  test("generateText with custom context and storage options", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "5" }),
    );
    const result = await t.action(api.index.generateTextWithThread, {
      threadId,
      userId: "5",
      messages: [{ role: "user", content: "Test" }],
      contextOptions: { recentMessages: 1 },
      storageOptions: { saveMessages: "all" },
    });
    expect(result.text).toEqual(TEST_TEXT);
  });

  test("generateObject returns object", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "6" }),
    );
    const result = await t.action(api.index.generateObjectWithThread, {
      threadId,
      userId: "6",
      prompt: "Object please",
    });
    expect(result.object).toEqual({ hello: "world" });
  });
});

describe("Agent-generated mutations/actions/queries", () => {
  test("createThreadMutation works via t.mutation", async () => {
    const t = createTest();
    // This test is for the registered mutation, not the agent method
    const result = await t.mutation(api.index.createThreadManually, {});
    expect(result.threadId).toBeTypeOf("string");
  });

  test("asTextAction and asObjectAction work via t.action", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "8" }),
    );
    const textResult = await t.action(internal.index.generateTextAction, {
      userId: "8",
      threadId,
      messages: [{ role: "user", content: "Say hi" }],
    });
    expect(textResult.text).toEqual(TEST_TEXT);

    const objResult = await t.action(internal.index.generateObjectAction, {
      userId: "8",
      threadId,
      messages: [{ role: "user", content: "Give object" }],
    });
    expect(objResult.object).toBeDefined();
  });

  test("asTextAction maps its system wire field to AI SDK instructions", async () => {
    const t = createTest();
    const before = agentModel.doGenerateCalls.length;

    await t.action(internal.index.generateTextAction, {
      userId: "8",
      system: "Action-scoped instructions",
      prompt: "Say hi",
    });

    const call = agentModel.doGenerateCalls.at(-1);
    expect(agentModel.doGenerateCalls).toHaveLength(before + 1);
    expect(call?.prompt[0]).toEqual({
      role: "system",
      content: "Action-scoped instructions",
    });
    expect(call).not.toHaveProperty("system");
  });

  test("asSaveMessagesMutation works via t.mutation", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "9" }),
    );
    const result = await t.mutation(internal.index.saveMessageMutation, {
      threadId,
      messages: [
        {
          message: { role: "user", content: "Saved via mutation" },
          // add more metadata fields as needed
        },
      ],
    });
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]._id).toBeDefined();
  });
});

describe("Agent context and search options", () => {
  test("fetchContextMessages returns context messages", async () => {
    const t = createTest();
    const threadId = await t.run(async (ctx) =>
      createThread(ctx, components.agent, { userId: "10" }),
    );
    await t.run(async (ctx) =>
      agent.saveMessage(ctx, {
        threadId,
        userId: "10",
        message: { role: "user", content: "Context test" },
      }),
    );
    const context = await t.action(api.index.fetchContextAction, {
      userId: "10",
      threadId,
      messages: [{ role: "user", content: "Context test" }],
      contextOptions: { recentMessages: 1 },
    });
    expect(context.length).toBeGreaterThan(0);
  });
});
