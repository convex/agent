import { describe, expect, test } from "vitest";
import { v } from "convex/values";
import { stepCountIs } from "ai";
import { createProviderExecutedToolFactory } from "@ai-sdk/provider-utils";
import { z } from "zod/v4";
import {
  Agent,
  createTool,
  listMessages,
  listUIMessages,
  saveMessage,
  saveMessages,
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

const aborts = new Map<string, AbortController>();
const lookup = createTool({
  inputSchema: z.object({ q: z.string() }),
  execute: async (_ctx, { q }) => {
    const controller = aborts.get(q);
    if (controller) {
      controller.abort("Stopped");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return `Found ${q}`;
  },
});

const tools = { getLocation, deleteFile, lookup };
const callIds: Record<string, string> = {
  getLocation: "tc-client",
  deleteFile: "tc-delete",
  lookup: "tc-server",
};
const PARIS = "You are in Paris.";

const models = new Map<string, MockLanguageModel>();
function agentFor(name: string, steps = [["getLocation"]]) {
  let model = models.get(name);
  if (!model) {
    model = mockModel({
      contentSteps: [
        ...steps.map((toolNames) =>
          toolNames.map((entry) => {
            if (entry === "text") return { type: "text" as const, text: PARIS };
            const [toolName, toolCallId = callIds[toolName]] = entry.split(":");
            return {
              type: "tool-call" as const,
              toolCallId,
              toolName,
              input: JSON.stringify(
                toolName === "deleteFile"
                  ? { filename: "a.txt" }
                  : toolName === "lookup"
                    ? { q: "a" }
                    : { precise: true },
              ),
            };
          }),
        ),
        [{ type: "text", text: PARIS }],
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
    steps: v.optional(v.array(v.array(v.string()))),
  },
  handler: async (ctx, { name, stream, toolNames, steps }) => {
    const agent = agentFor(name, steps ?? (toolNames && [toolNames]));
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
    promptMessageId: v.optional(v.string()),
    prompt: v.optional(v.string()),
    stream: v.boolean(),
    contextOptions: v.optional(
      v.object({
        recentMessages: v.optional(v.number()),
        excludeToolMessages: v.optional(v.boolean()),
      }),
    ),
    withoutClientTool: v.optional(v.boolean()),
    saveNothing: v.optional(v.boolean()),
    failing: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    {
      name,
      threadId,
      promptMessageId,
      prompt,
      stream,
      contextOptions,
      withoutClientTool,
      saveNothing,
      failing,
    },
  ) => {
    const agent = failing
      ? new Agent(components.agent, {
          name,
          tools,
          languageModel: mockModel({ fail: true }),
        })
      : agentFor(name);
    const args = {
      promptMessageId,
      prompt,
      ...(withoutClientTool ? { tools: { deleteFile, lookup } } : {}),
    };
    const options = {
      contextOptions,
      ...(saveNothing
        ? { storageOptions: { saveMessages: "none" as const } }
        : {}),
    };
    let text: string;
    if (stream) {
      const result = await agent.streamText(ctx, { threadId }, args, {
        saveStreamDeltas: { chunking: "word", throttleMs: 0 },
        ...options,
      });
      await result.consumeStream();
      text = await result.text;
    } else {
      text = (await agent.generateText(ctx, { threadId }, args, options)).text;
    }
    const model = models.get(name)!;
    const calls = stream ? model.doStreamCalls : model.doGenerateCalls;
    return { text, prompt: JSON.parse(JSON.stringify(calls.at(-1)!.prompt)) };
  },
});

// Streams a step whose model fails, or whose server tool aborts the stream,
// after the call is emitted, leaving a failed row that holds the call.
const failStep = app.action({
  args: {
    toolName: v.union(
      v.literal("lookup"),
      v.literal("getLocation"),
      v.literal("both"),
    ),
    mode: v.union(v.literal("error"), v.literal("abort")),
  },
  handler: async (ctx, { toolName, mode }) => {
    const toolNames =
      toolName === "both" ? (["getLocation", "lookup"] as const) : [toolName];
    const agent = new Agent(components.agent, {
      name: `failing-${toolName}-${mode}`,
      tools,
      stopWhen: stepCountIs(5),
      languageModel: mockModel({
        contentSteps: [
          toolNames.map((name) => ({
            type: "tool-call" as const,
            toolCallId: callIds[name],
            toolName: name,
            input: JSON.stringify(
              name === "lookup" ? { q: mode } : { precise: true },
            ),
          })),
        ],
        fail: mode === "error",
      }),
    });
    const { threadId } = await agent.createThread(ctx, {});
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId,
      prompt: "Where am I?",
    });
    const controller = new AbortController();
    if (mode === "abort") aborts.set(mode, controller);
    try {
      const result = await agent.streamText(
        ctx,
        { threadId },
        { promptMessageId: messageId, abortSignal: controller.signal },
        { saveStreamDeltas: { chunking: "word", throttleMs: 0 } },
      );
      await result.consumeStream();
    } catch {
      // The failure is what this sets up.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { threadId, promptMessageId: messageId };
  },
});

const retry = app.action({
  args: { threadId: v.string(), promptMessageId: v.string() },
  handler: async (ctx, { threadId, promptMessageId }) => {
    const agent = new Agent(components.agent, {
      name: "retry",
      tools,
      languageModel: mockModel({ content: [{ type: "text", text: PARIS }] }),
    });
    const result = await agent.generateText(
      ctx,
      { threadId },
      { promptMessageId },
    );
    return result.text;
  },
});

const webSearch = createProviderExecutedToolFactory({
  id: "openai.web_search",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
})({});

// The component queries a continuation runs, for an agent with server and
// provider-executed tools but no client tool.
const continuationQueries = app.action({
  args: {
    withProviderTool: v.boolean(),
    fromPrompt: v.boolean(),
    contextOptions: v.object({
      recentMessages: v.optional(v.number()),
      excludeToolMessages: v.optional(v.boolean()),
    }),
  },
  handler: async (ctx, { withProviderTool, fromPrompt, contextOptions }) => {
    const agent = new Agent(components.agent, {
      name: "no-client-tool",
      tools: withProviderTool ? { lookup, webSearch } : { lookup },
      stopWhen: stepCountIs(5),
      languageModel: mockModel({
        contentSteps: [
          [
            {
              type: "tool-call",
              toolCallId: callIds.lookup,
              toolName: "lookup",
              input: JSON.stringify({ q: "a" }),
            },
          ],
          [{ type: "text", text: PARIS }],
          [{ type: "text", text: PARIS }],
        ],
      }),
    });
    const { threadId } = await agent.createThread(ctx, {});
    const { promptMessageId } = await agent.generateText(
      ctx,
      { threadId },
      { prompt: "Where am I?" },
    );
    const queries: string[] = [];
    const recording = {
      ...ctx,
      runQuery: ((ref: any, args: any) => {
        queries.push(String(ref[Symbol.for("toReferencePath")]));
        return ctx.runQuery(ref, args);
      }) as typeof ctx.runQuery,
    };
    await agent
      .generateText(
        recording,
        { threadId },
        { promptMessageId: fromPrompt ? promptMessageId : undefined },
        { contextOptions },
      )
      // With no recent messages the prompt is empty, which the AI SDK
      // rejects after the queries ran.
      .catch(() => {});
    return queries;
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
  args: {
    threadId: v.string(),
    approved: v.boolean(),
    toolCallId: v.optional(v.string()),
  },
  handler: async (ctx, { threadId, approved, toolCallId }) => {
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
      .find(
        (p) =>
          p.type === "tool-approval-request" &&
          (toolCallId === undefined || p.toolCallId === toolCallId),
      );
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

const saveDeleteResult = app.mutation({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) =>
    saveMessage(ctx, components.agent, {
      threadId,
      message: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-delete",
            toolName: "deleteFile",
            output: { type: "text", value: "Deleted a.txt" },
          },
        ],
      },
    }),
});

// Saves text on the first order, optionally after a system or user message on
// that order, or only that message.
const saveStepText = app.mutation({
  args: {
    threadId: v.string(),
    before: v.optional(v.union(v.literal("system"), v.literal("user"))),
    alone: v.optional(v.boolean()),
  },
  handler: async (ctx, { threadId, before, alone }) => {
    const { page } = await listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    const user = page.find((m) => m.message?.role === "user")!;
    const text = { role: "assistant" as const, content: "Moving on." };
    const first = before && { role: before, content: "Be brief." };
    return saveMessages(ctx, components.agent, {
      threadId,
      ...(before === "user"
        ? { order: user.order }
        : { promptMessageId: user._id }),
      messages: first ? (alone ? [first] : [first, text]) : [text],
    });
  },
});

// Two generations on one order reserve their pending messages before either
// finishes, then the first saves a client call and the second saves text,
// text after a result for another call in the first step, or a system or user
// message, or is still pending.
const raceSteps = app.mutation({
  args: {
    second: v.optional(
      v.union(
        v.literal("afterResult"),
        v.literal("system"),
        v.literal("user"),
        v.literal("pending"),
      ),
    ),
  },
  handler: async (ctx, { second: secondSave }) => {
    const afterResult = secondSave === "afterResult";
    const { threadId } = await agentFor("mutations").createThread(ctx, {});
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId,
      prompt: "Where am I?",
    });
    const reserve = async () =>
      (
        await saveMessages(ctx, components.agent, {
          threadId,
          promptMessageId: messageId,
          messages: [{ role: "assistant", content: [] }],
          metadata: [{ status: "pending" }],
        })
      ).messages[0]._id;
    const first = await reserve();
    const second = await reserve();
    await saveMessages(ctx, components.agent, {
      threadId,
      pendingMessageId: first,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "tc-client",
              toolName: "getLocation",
              input: { precise: true },
            },
            ...(afterResult
              ? [
                  {
                    type: "tool-call" as const,
                    toolCallId: "tc-server",
                    toolName: "lookup",
                    input: {},
                  },
                ]
              : []),
          ],
        },
      ],
    });
    if (secondSave === "pending") return threadId;
    await saveMessages(ctx, components.agent, {
      threadId,
      pendingMessageId: second,
      messages: [
        ...(afterResult
          ? [
              {
                role: "tool" as const,
                content: [
                  {
                    type: "tool-result" as const,
                    toolCallId: "tc-server",
                    toolName: "lookup",
                    output: { type: "text" as const, value: "found" },
                  },
                ],
              },
            ]
          : []),
        secondSave === "system"
          ? { role: "system", content: "Be brief." }
          : secondSave === "user"
            ? { role: "user", content: [{ type: "text", text: "Be brief." }] }
            : { role: "assistant", content: "Moving on." },
      ],
    });
    return threadId;
  },
});

// A server tool's call saved without its result, as when importing history.
const saveServerCall = app.mutation({
  args: {},
  handler: async (ctx) => {
    const { threadId } = await agentFor("mutations").createThread(ctx, {});
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId,
      prompt: "Look it up",
    });
    await saveMessage(ctx, components.agent, {
      threadId,
      promptMessageId: messageId,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-server",
            toolName: "lookup",
            input: { q: "a" },
          },
        ],
      },
    });
    return { threadId, promptMessageId: messageId };
  },
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
      docs: page.map((m) => ({
        _id: m._id,
        order: m.order,
        role: m.message?.role,
      })),
      results: page.flatMap((m) =>
        m.message?.role === "tool"
          ? m.message.content.filter((p) => p.type === "tool-result")
          : [],
      ),
      toolParts: ui.page
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "tool-getLocation"),
    };
  },
});

const rows = app.query({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const { page } = await listMessages(ctx, components.agent, {
      threadId,
      statuses: ["success", "failed", "pending"],
      paginationOpts: { cursor: null, numItems: 50 },
    });
    return page
      .reverse()
      .map(
        (m) =>
          `${m.order}.${m.stepOrder} ${m.status} ${m.message?.role}:${
            Array.isArray(m.message?.content)
              ? m.message.content.map((p) => p.type).join(",")
              : "text"
          }`,
      );
  },
});

const { api, createTest } = app.defineModules({
  clientTools: {
    start,
    cont,
    addOutput,
    decide,
    saveProviderCall,
    saveDeleteResult,
    saveStepText,
    raceSteps,
    saveServerCall,
    saveUserMessage,
    messages,
    rows,
    failStep,
    retry,
    continuationQueries,
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

// Providers with strict turn ordering need each call answered by the very
// next message.
function expectEveryCallAnsweredNext(prompt: any[]) {
  for (const [i, message] of prompt.entries()) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const callIds = message.content
      .filter((p: any) => p.type === "tool-call" && !p.providerExecuted)
      .map((p: any) => p.toolCallId);
    if (callIds.length === 0) continue;
    const next = prompt[i + 1];
    expect(next?.role).toBe("tool");
    expect(
      next.content
        .filter((p: any) => p.type === "tool-result")
        .map((p: any) => p.toolCallId)
        .sort(),
    ).toEqual([...callIds].sort());
  }
}

describe("addToolOutput", () => {
  test("createTool without execute or outputSchema defines a client tool", () => {
    expect(getLocation.execute).toBeUndefined();
  });

  test("createTool rejects a client tool that needs approval", () => {
    expect(() =>
      createTool({
        inputSchema: z.object({ precise: z.boolean() }),
        needsApproval: true,
      }),
    ).toThrow(/cannot need approval/);
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
      expect(next.text).toBe(PARIS);
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

  for (const [output, saved] of [
    ["Paris", { type: "text", value: "Paris" }],
    [undefined, { type: "json", value: null }],
  ] as const) {
    test(`an output of ${JSON.stringify(output) ?? "undefined"} is saved as ${saved.type}`, async () => {
      const t = createTest();
      const threadId = await t.action(api.clientTools.start, {
        name: `output-${saved.type}`,
        stream: false,
      });
      await t.mutation(api.clientTools.addOutput, {
        threadId,
        toolCallId: "tc-client",
        output,
      });
      const { results } = await t.query(api.clientTools.messages, {
        threadId,
      });
      expect(results).toEqual([
        expect.objectContaining({ toolCallId: "tc-client", output: saved }),
      ]);
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

  for (const approved of [true, false]) {
    test(`an output after ${approved ? "an approval" : "a denial"} is rejected`, async () => {
      const t = createTest();
      const threadId = await t.action(api.clientTools.start, {
        name: `after-${approved}`,
        stream: false,
        toolNames: ["deleteFile"],
      });
      await t.mutation(api.clientTools.decide, { threadId, approved });
      await expect(
        t.mutation(api.clientTools.addOutput, {
          threadId,
          tool: "deleteFile",
          toolCallId: "tc-delete",
          output: "done",
        }),
      ).rejects.toThrow(/Tool call tc-delete was already handled/);
    });
  }

  for (const approved of [true, false]) {
    test(`${approved ? "an approval" : "a denial"} after a result is rejected`, async () => {
      const t = createTest();
      const threadId = await t.action(api.clientTools.start, {
        name: `result-then-${approved}`,
        stream: false,
        toolNames: ["deleteFile"],
      });
      await t.mutation(api.clientTools.saveDeleteResult, { threadId });
      await expect(
        t.mutation(api.clientTools.decide, { threadId, approved }),
      ).rejects.toThrow(/already handled/);
    });
  }

  test("an output naming another tool is rejected", async () => {
    const t = createTest();
    const threadId = await t.action(api.clientTools.start, {
      name: "other-tool",
      stream: false,
    });
    await expect(
      t.mutation(api.clientTools.addOutput, {
        threadId,
        tool: "deleteFile",
        toolCallId: "tc-client",
        output: "done",
      }),
    ).rejects.toThrow(
      /Tool call tc-client is a call to getLocation, not deleteFile/,
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
        expect(next.text).toBe(PARIS);
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

  test("a mixed step does not continue from the decision until the client call has its output", async () => {
    const t = createTest();
    const name = "mixed-waits";
    const threadId = await t.action(api.clientTools.start, {
      name,
      stream: false,
      toolNames: ["getLocation", "deleteFile"],
    });
    const decision = await t.mutation(api.clientTools.decide, {
      threadId,
      approved: true,
    });
    executed.length = 0;
    await expect(
      t.action(api.clientTools.cont, {
        name,
        threadId,
        promptMessageId: decision.messageId,
        stream: false,
      }),
    ).rejects.toThrow(/Tool call tc-client \(getLocation\) has no output yet/);
    expect(executed).toEqual([]);

    const { messageId } = await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client",
      output: { city: "Paris" },
    });
    const next = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: messageId,
      stream: false,
    });
    expect(next.text).toBe(PARIS);
    expect(executed).toEqual(["a.txt"]);
    expectEveryCallAnsweredNext(next.prompt);

    const prompt = await t.mutation(api.clientTools.saveUserMessage, {
      threadId,
      prompt: "Thanks",
    });
    const later = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: prompt.messageId,
      stream: false,
    });
    expectEveryCallAnsweredNext(later.prompt);
    expect(promptRoles(later.prompt)).toEqual([
      "user:text",
      "assistant:tool-call:tool-call",
      "tool:tool-result:tool-result",
      "assistant:text",
      "user:text",
    ]);
  });

  test("a mixed step does not continue from the output until its approval is decided", async () => {
    const t = createTest();
    const name = "mixed-waits-for-decision";
    const threadId = await t.action(api.clientTools.start, {
      name,
      stream: false,
      toolNames: ["getLocation", "deleteFile"],
    });
    const output = await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client",
      output: { city: "Paris" },
    });
    const calls = models.get(name)!.doGenerateCalls.length;
    await expect(
      t.action(api.clientTools.cont, {
        name,
        threadId,
        promptMessageId: output.messageId,
        stream: false,
      }),
    ).rejects.toThrow(
      /Tool call tc-delete \(deleteFile\) is awaiting approval/,
    );
    expect(models.get(name)!.doGenerateCalls.length).toBe(calls);

    executed.length = 0;
    const { messageId } = await t.mutation(api.clientTools.decide, {
      threadId,
      approved: true,
    });
    const next = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: messageId,
      stream: false,
    });
    expect(next.text).toBe(PARIS);
    expect(executed).toEqual(["a.txt"]);
    expectEveryCallAnsweredNext(next.prompt);
  });

  test("a step with two client calls does not continue until both have outputs", async () => {
    const t = createTest();
    const name = "two-client-calls";
    const threadId = await t.action(api.clientTools.start, {
      name,
      stream: false,
      toolNames: ["getLocation", "getLocation:tc-client-2"],
    });
    const first = await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client",
      output: { city: "Paris" },
    });
    await expect(
      t.action(api.clientTools.cont, {
        name,
        threadId,
        promptMessageId: first.messageId,
        stream: false,
      }),
    ).rejects.toThrow(
      /Tool call tc-client-2 \(getLocation\) has no output yet/,
    );

    const { messageId } = await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client-2",
      output: { city: "Paris" },
    });
    const next = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: messageId,
      stream: false,
    });
    expect(next.text).toBe(PARIS);
    expectEveryCallAnsweredNext(next.prompt);
  });

  test("a step with two client calls continues from the first output once both are saved", async () => {
    const t = createTest();
    const name = "two-client-calls-first";
    const threadId = await t.action(api.clientTools.start, {
      name,
      stream: false,
      toolNames: ["getLocation", "getLocation:tc-client-2"],
    });
    const first = await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client",
      output: { city: "Paris" },
    });
    await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client-2",
      output: { city: "Lyon" },
    });
    const next = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: first.messageId,
      stream: false,
    });
    expect(next.text).toBe(PARIS);
    expectEveryCallAnsweredNext(next.prompt);
  });

  test("a step does not continue without a promptMessageId until its client calls have outputs", async () => {
    const t = createTest();
    const name = "two-client-calls-no-prompt";
    const threadId = await t.action(api.clientTools.start, {
      name,
      stream: false,
      toolNames: ["getLocation", "getLocation:tc-client-2"],
    });
    await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client",
      output: { city: "Paris" },
    });
    await expect(
      t.action(api.clientTools.cont, { name, threadId, stream: false }),
    ).rejects.toThrow(
      /Tool call tc-client-2 \(getLocation\) has no output yet/,
    );
  });

  test("a step does not continue from its own call message until the call has its output", async () => {
    const t = createTest();
    const name = "from-call";
    const threadId = await t.action(api.clientTools.start, {
      name,
      stream: false,
    });
    const { docs } = await t.query(api.clientTools.messages, { threadId });
    const call = docs.find((m) => m.role === "assistant")!;
    await expect(
      t.action(api.clientTools.cont, {
        name,
        threadId,
        promptMessageId: call._id,
        stream: false,
      }),
    ).rejects.toThrow(/Tool call tc-client \(getLocation\) has no output yet/);
    await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client",
      output: { city: "Paris" },
    });
  });

  test("resuming an older approval waits for a newer step's client call", async () => {
    const t = createTest();
    const name = "older-approval";
    const threadId = await t.action(api.clientTools.start, {
      name,
      stream: false,
      steps: [["deleteFile", "deleteFile:tc-delete-2"], ["getLocation"]],
    });
    const first = await t.mutation(api.clientTools.decide, {
      threadId,
      approved: true,
      toolCallId: "tc-delete",
    });
    await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: first.messageId,
      stream: false,
    });
    const second = await t.mutation(api.clientTools.decide, {
      threadId,
      approved: true,
      toolCallId: "tc-delete-2",
    });
    await expect(
      t.action(api.clientTools.cont, {
        name,
        threadId,
        promptMessageId: second.messageId,
        stream: false,
      }),
    ).rejects.toThrow(/Tool call tc-client \(getLocation\) has no output yet/);
    await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client",
      output: { city: "Paris" },
    });
  });

  for (const stream of [false, true]) {
    test(`${stream ? "streamText" : "generateText"}: a replacement prompt does not continue an order before its client calls have outputs`, async () => {
      const t = createTest();
      const name = `replacement-${stream}`;
      const threadId = await t.action(api.clientTools.start, { name, stream });
      const { docs } = await t.query(api.clientTools.messages, { threadId });
      const user = docs.find((m) => m.role === "user")!;
      await expect(
        t.action(api.clientTools.cont, {
          name,
          threadId,
          promptMessageId: user._id,
          prompt: "Try again",
          stream,
        }),
      ).rejects.toThrow(
        /Tool call tc-client \(getLocation\) has no output yet/,
      );
    });
  }

  for (const contextOptions of [
    { recentMessages: 0 },
    { recentMessages: 1 },
    { excludeToolMessages: true },
  ] as { recentMessages?: number; excludeToolMessages?: boolean }[]) {
    for (const fromCall of [true, false]) {
      test(`a step does not continue ${fromCall ? "from its call" : "without a promptMessageId"} with ${JSON.stringify(contextOptions)} until its client calls have outputs`, async () => {
        const t = createTest();
        const name = `context-${JSON.stringify(contextOptions)}-${fromCall}`;
        const threadId = await t.action(api.clientTools.start, {
          name,
          stream: false,
          toolNames: ["getLocation", "getLocation:tc-client-2"],
        });
        const { docs } = await t.query(api.clientTools.messages, { threadId });
        const call = docs.find((m) => m.role === "assistant")!;
        const first = await t.mutation(api.clientTools.addOutput, {
          threadId,
          toolCallId: "tc-client",
          output: { city: "Paris" },
        });
        const continueStep = (promptMessageId: string) =>
          t.action(api.clientTools.cont, {
            name,
            threadId,
            promptMessageId: fromCall ? promptMessageId : undefined,
            stream: false,
            contextOptions,
          });
        await expect(continueStep(call._id)).rejects.toThrow(
          /Tool call tc-client-2 \(getLocation\) has no output yet/,
        );
        await expect(continueStep(first.messageId)).rejects.toThrow(
          /Tool call tc-client-2 \(getLocation\) has no output yet/,
        );
        const { messageId } = await t.mutation(api.clientTools.addOutput, {
          threadId,
          toolCallId: "tc-client-2",
          output: { city: "Paris" },
        });
        // With no recent messages the prompt is empty, which the AI SDK
        // rejects, so only the check is exercised.
        if (contextOptions.recentMessages === 0) return;
        expect((await continueStep(messageId)).text).toBe(PARIS);
      });
    }
  }

  test("a step does not continue without saving its messages until its client call has its output, and runs no approved tool", async () => {
    const t = createTest();
    const name = "save-nothing";
    const threadId = await t.action(api.clientTools.start, {
      name,
      stream: false,
      toolNames: ["getLocation", "deleteFile"],
    });
    const decision = await t.mutation(api.clientTools.decide, {
      threadId,
      approved: true,
    });
    executed.length = 0;
    await expect(
      t.action(api.clientTools.cont, {
        name,
        threadId,
        promptMessageId: decision.messageId,
        stream: false,
        saveNothing: true,
      }),
    ).rejects.toThrow(/Tool call tc-client \(getLocation\) has no output yet/);
    expect(executed).toEqual([]);
  });

  test("a call to a server tool without its result does not hold its step", async () => {
    const t = createTest();
    const name = "server-call";
    const { threadId, promptMessageId } = await t.mutation(
      api.clientTools.saveServerCall,
      {},
    );
    const next = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId,
      stream: false,
    });
    expect(promptRoles(next.prompt).slice(-1)).toEqual(["user:text"]);
  });

  for (const [contextOptions, fromPrompt] of [
    [{ recentMessages: 0 }, true],
    [{ excludeToolMessages: true }, false],
  ] as const) {
    test(`a continuation with only server and provider-executed tools runs no extra query with ${JSON.stringify(contextOptions)}`, async () => {
      const t = createTest();
      const run = (withProviderTool: boolean) =>
        t.action(api.clientTools.continuationQueries, {
          withProviderTool,
          fromPrompt,
          contextOptions,
        });
      const queries = await run(true);
      expect(queries.some((q) => q.endsWith("getNewestStep"))).toBe(false);
      expect(queries).toEqual(await run(false));
    });
  }

  test("a generation whose tools lack the client tool continues its step, and the call's output is then rejected", async () => {
    const t = createTest();
    const name = "without-client-tool";
    const threadId = await t.action(api.clientTools.start, {
      name,
      stream: false,
    });
    const { docs } = await t.query(api.clientTools.messages, { threadId });
    const call = docs.find((m) => m.role === "assistant")!;
    const next = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: call._id,
      stream: false,
      withoutClientTool: true,
    });
    expect(next.text).toBe(PARIS);
    await expect(
      t.mutation(api.clientTools.addOutput, {
        threadId,
        toolCallId: "tc-client",
        output: { city: "Paris" },
      }),
    ).rejects.toThrow(
      /Tool call tc-client was not answered before its step continued/,
    );
  });

  for (const second of [
    undefined,
    "system",
    "user",
    "afterResult",
    "pending",
  ] as const) {
    test(`an output after a concurrent generation saved ${second ?? "text"} on its order is rejected`, async () => {
      const t = createTest();
      const threadId = await t.mutation(api.clientTools.raceSteps, { second });
      await expect(
        t.mutation(api.clientTools.addOutput, {
          threadId,
          toolCallId: "tc-client",
          output: { city: "Paris" },
        }),
      ).rejects.toThrow(
        /Tool call tc-client was not answered before its step continued/,
      );
    });
  }

  for (const [before, alone] of [
    [undefined, false],
    ["system", true],
    ["system", false],
    ["user", true],
    ["user", false],
  ] as const) {
    test(`a ${before ?? "text"} message${before && !alone ? " and text" : ""} saved by hand after a client call is saved, and the call's output is then rejected`, async () => {
      const t = createTest();
      const threadId = await t.action(api.clientTools.start, {
        name: `by-hand-${before}-${alone}`,
        stream: false,
      });
      await t.mutation(api.clientTools.saveStepText, {
        threadId,
        before,
        alone,
      });
      await expect(
        t.mutation(api.clientTools.addOutput, {
          threadId,
          toolCallId: "tc-client",
          output: { city: "Paris" },
        }),
      ).rejects.toThrow(
        /Tool call tc-client was not answered before its step continued/,
      );
    });
  }

  test("an output after a newer prompt is saved on its call's order and continues that order", async () => {
    const t = createTest();
    const name = "late-output";
    const threadId = await t.action(api.clientTools.start, {
      name,
      stream: false,
      steps: [["getLocation"], ["text"]],
    });
    const prompt = await t.mutation(api.clientTools.saveUserMessage, {
      threadId,
      prompt: "Anything else?",
    });
    const meanwhile = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: prompt.messageId,
      stream: false,
    });
    expect(promptRoles(meanwhile.prompt)).toEqual(["user:text", "user:text"]);

    const { messageId } = await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client",
      output: { city: "Paris" },
    });
    const late = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: messageId,
      stream: false,
    });
    expect(promptRoles(late.prompt)).toEqual([
      "user:text",
      "assistant:tool-call",
      "tool:tool-result",
    ]);
    await expect(
      t.mutation(api.clientTools.addOutput, {
        threadId,
        toolCallId: "tc-client",
        output: { city: "Rome" },
      }),
    ).rejects.toThrow(/Tool call tc-client was already handled/);

    const thanks = await t.mutation(api.clientTools.saveUserMessage, {
      threadId,
      prompt: "Thanks",
    });
    const after = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: thanks.messageId,
      stream: false,
    });
    expectEveryCallAnsweredNext(after.prompt);
    expect(promptRoles(after.prompt)).toEqual([
      "user:text",
      "assistant:tool-call",
      "tool:tool-result",
      "assistant:text",
      "user:text",
      "assistant:text",
      "user:text",
    ]);
  });

  test("a continuation that failed is retried from the same output", async () => {
    const t = createTest();
    const name = "failed-continuation";
    const threadId = await t.action(api.clientTools.start, {
      name,
      stream: false,
    });
    const { messageId } = await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client",
      output: { city: "Paris" },
    });
    await expect(
      t.action(api.clientTools.cont, {
        name,
        threadId,
        promptMessageId: messageId,
        stream: false,
        failing: true,
      }),
    ).rejects.toThrow(/Mock error message/);
    const next = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: messageId,
      stream: false,
    });
    expect(next.text).toBe(PARIS);
    expectEveryCallAnsweredNext(next.prompt);
  });

  for (const [toolName, mode] of [
    ["getLocation", "error"],
    ["both", "abort"],
  ] as const) {
    test(`a client call in a stream that ${mode === "error" ? "failed" : "was aborted during a server tool"} takes no output, and its step is retried`, async () => {
      const t = createTest();
      const { threadId, promptMessageId } = await t.action(
        api.clientTools.failStep,
        { toolName, mode },
      );
      const failed =
        toolName === "both"
          ? "0.1 failed assistant:tool-call,tool-call"
          : "0.1 failed assistant:tool-call";
      expect(await t.query(api.clientTools.rows, { threadId })).toEqual([
        "0.0 success user:text",
        failed,
      ]);
      await expect(
        t.mutation(api.clientTools.addOutput, {
          threadId,
          toolCallId: "tc-client",
          output: { city: "Paris" },
        }),
      ).rejects.toThrow(/Tool call tc-client was not found/);
      expect(
        await t.action(api.clientTools.retry, { threadId, promptMessageId }),
      ).toBe(PARIS);
      expect(await t.query(api.clientTools.rows, { threadId })).toEqual([
        "0.0 success user:text",
        failed,
        "0.2 success assistant:text",
      ]);
    });
  }

  test("an output for a call awaiting approval is rejected", async () => {
    const t = createTest();
    const threadId = await t.action(api.clientTools.start, {
      name: "awaiting",
      stream: false,
      toolNames: ["deleteFile"],
    });
    await expect(
      t.mutation(api.clientTools.addOutput, {
        threadId,
        tool: "deleteFile",
        toolCallId: "tc-delete",
        output: "done",
      }),
    ).rejects.toThrow(/Tool call tc-delete is awaiting approval/);
  });

  test("an output for a provider-executed call is rejected", async () => {
    const t = createTest();
    const threadId = await t.action(api.clientTools.start, {
      name: "provider",
      stream: false,
      toolNames: ["deleteFile"],
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

describe("a stream that failed after a server tool call", () => {
  for (const mode of ["error", "abort"] as const) {
    test(`is retried after ${mode === "error" ? "a model error" : "an abort"} as before client tools`, async () => {
      const t = createTest();
      const { threadId, promptMessageId } = await t.action(
        api.clientTools.failStep,
        { toolName: "lookup", mode },
      );
      expect(await t.query(api.clientTools.rows, { threadId })).toEqual([
        "0.0 success user:text",
        "0.1 failed assistant:tool-call",
      ]);
      expect(
        await t.action(api.clientTools.retry, { threadId, promptMessageId }),
      ).toBe(PARIS);
      expect(await t.query(api.clientTools.rows, { threadId })).toEqual([
        "0.0 success user:text",
        "0.1 failed assistant:tool-call",
        "0.2 success assistant:text",
      ]);
    });
  }
});
