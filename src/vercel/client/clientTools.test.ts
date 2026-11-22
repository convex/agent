import { describe, expect, onTestFinished, test, vi } from "vitest";
import { v } from "convex/values";
import { stepCountIs, tool, type ToolSet } from "ai";
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

const locationInput = z.object({ precise: z.boolean() });
// Built from `tool` so each test can fail on its own where `createTool`
// rejects a tool without `execute`.
const getLocation = tool({
  description: "Get the user's location from their browser",
  inputSchema: locationInput,
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

const lookup = createTool({
  inputSchema: z.object({ q: z.string() }),
  execute: async (_ctx, { q }) => `Found ${q}`,
});

const askName = tool({
  description: "Ask the user's name",
  inputSchema: z.object({}),
});
const webSearch = tool({
  type: "provider",
  id: "test.web_search",
  args: {},
  isProviderExecuted: true,
  inputSchema: z.object({}),
});

const tools = { getLocation, askName, deleteFile, lookup };
const toolsByName: Record<string, ToolSet[string]> = {
  ...tools,
  web_search: webSearch,
};
const pick = (names: string[]) =>
  Object.fromEntries(names.map((name) => [name, toolsByName[name]]));
const callIds: Record<string, string> = {
  getLocation: "tc-client",
  deleteFile: "tc-delete",
  lookup: "tc-server",
};
const PARIS = "You are in Paris.";

function toolCall(entry: string) {
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
}

const models = new Map<string, MockLanguageModel>();
function agentFor(name: string, steps = [["getLocation"]]) {
  let model = models.get(name);
  if (!model) {
    model = mockModel({
      contentSteps: [
        ...steps.map((entries) =>
          entries.map((entry) =>
            entry === "text"
              ? { type: "text" as const, text: PARIS }
              : toolCall(entry),
          ),
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
    toolNames: v.optional(v.array(v.string())),
    steps: v.optional(v.array(v.array(v.string()))),
  },
  handler: async (ctx, { name, toolNames, steps }) => {
    const agent = agentFor(name, steps ?? (toolNames && [toolNames]));
    const { threadId } = await agent.createThread(ctx, {});
    await agent.generateText(ctx, { threadId }, { prompt: "Where am I?" });
    return threadId;
  },
});

const cont = app.action({
  args: {
    name: v.string(),
    threadId: v.string(),
    promptMessageId: v.optional(v.string()),
    steps: v.optional(v.array(v.array(v.string()))),
    withoutClientTool: v.optional(v.boolean()),
    failing: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { name, threadId, promptMessageId, steps, withoutClientTool, failing },
  ) => {
    const agent = failing
      ? new Agent(components.agent, {
          name,
          tools,
          languageModel: mockModel({ fail: true }),
        })
      : agentFor(name, steps);
    const args = {
      promptMessageId,
      ...(withoutClientTool ? { tools: { deleteFile, lookup } } : {}),
    };
    const { text } = await agent.generateText(ctx, { threadId }, args);
    const calls = models.get(name)!.doGenerateCalls;
    return { text, prompt: JSON.parse(JSON.stringify(calls.at(-1)!.prompt)) };
  },
});

// Streams a step whose model fails after the call is emitted, leaving a
// failed row that holds the call.
const failStep = app.action({
  args: {},
  handler: async (ctx) => {
    const agent = new Agent(components.agent, {
      name: "failing-getLocation-error",
      tools,
      stopWhen: stepCountIs(5),
      languageModel: mockModel({
        contentSteps: [[toolCall("getLocation")]],
        fail: true,
      }),
    });
    const { threadId } = await agent.createThread(ctx, {});
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId,
      prompt: "Where am I?",
    });
    try {
      const result = await agent.streamText(
        ctx,
        { threadId },
        { promptMessageId: messageId },
        { saveStreamDeltas: { chunking: "word", throttleMs: 0 } },
      );
      await result.consumeStream();
    } catch {
      // The failure is what this sets up.
    }
    return { threadId, promptMessageId: messageId };
  },
});

// Runs one component call inside a mutation to count what it reads.
const readsOf = app.mutation({
  args: {
    kind: v.union(v.literal("query"), v.literal("mutation")),
    name: v.string(),
    args: v.any(),
  },
  handler: async (ctx, { kind, name, args }) => {
    const [module, fn] = name.split("/");
    const ref = (components.agent as any)[module][fn];
    const before = await ctx.meta.getTransactionMetrics();
    const result =
      kind === "query"
        ? await ctx.runQuery(ref, args)
        : await ctx.runMutation(ref, args);
    const after = await ctx.meta.getTransactionMetrics();
    return {
      result,
      documents: after.documentsRead.used - before.documentsRead.used,
    };
  },
});

const addOutput = app.mutation({
  args: {
    threadId: v.string(),
    tool: v.optional(v.string()),
    toolCallId: v.string(),
    output: v.optional(v.any()),
    errorText: v.optional(v.string()),
    agentTools: v.optional(v.array(v.string())),
    tools: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { threadId, toolCallId, output, errorText } = args;
    const tool = args.tool ?? "getLocation";
    const agent = args.agentTools
      ? new Agent(components.agent, {
          name: "mutations",
          tools: pick(args.agentTools),
          languageModel: mockModel(),
        })
      : agentFor("mutations");
    const perCall = args.tools && { tools: pick(args.tools) };
    return errorText === undefined
      ? agent.addToolOutput(ctx, {
          threadId,
          tool,
          toolCallId,
          output,
          ...perCall,
        })
      : agent.addToolOutput(ctx, {
          threadId,
          tool,
          toolCallId,
          state: "output-error",
          errorText,
          ...perCall,
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

// Saves a message on the first order, as an app or another generation can.
const saveOnFirstOrder = app.mutation({
  args: { threadId: v.string(), message: v.any() },
  handler: async (ctx, { threadId, message }) => {
    const { page } = await listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    const user = page.find((m) => m.message?.role === "user")!;
    return saveMessage(ctx, components.agent, {
      threadId,
      promptMessageId: user._id,
      message,
    });
  },
});

// Two generations on one order reserve their pending messages before either
// finishes. The first saves a client call; the second is still pending.
const raceSteps = app.mutation({
  args: {},
  handler: async (ctx) => {
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
    await reserve();
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
          ],
        },
      ],
    });
    return threadId;
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
      statuses: ["success", "failed", "pending"],
      paginationOpts: { cursor: null, numItems: 50 },
    });
    const ui = await listUIMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 50 },
    });
    return {
      docs: page.map((m) => ({ _id: m._id, order: m.order })),
      rows: page
        .map(
          (m) =>
            `${m.order}.${m.stepOrder} ${m.status} ${m.message?.role}:${
              Array.isArray(m.message?.content)
                ? m.message.content.map((p) => p.type).join(",")
                : "text"
            }`,
        )
        .reverse(),
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

const { api, createTest } = app.defineModules({
  clientTools: {
    start,
    cont,
    failStep,
    readsOf,
    addOutput,
    decide,
    saveOnFirstOrder,
    raceSteps,
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
  test("createTool defines a client tool without execute, but not one that needs approval", () => {
    const client = createTool({ inputSchema: locationInput });
    expect(client.execute).toBeUndefined();
    expect(() =>
      createTool({ inputSchema: locationInput, needsApproval: true }),
    ).toThrow(/cannot need approval/);
  });

  test("generateText: the output is saved next to its call and the continuation sees call then result", async () => {
    const t = createTest();
    const name = "order-generateText";
    const threadId = await t.action(api.clientTools.start, { name });
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
    expect(after.docs.find((m) => m._id === messageId)?.order).toBe(callOrder);
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

  test("an output of undefined is saved as json", async () => {
    const t = createTest();
    const threadId = await t.action(api.clientTools.start, {
      name: "output-json",
    });
    await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client",
      output: undefined,
    });
    const { results } = await t.query(api.clientTools.messages, {
      threadId,
    });
    expect(results).toEqual([
      expect.objectContaining({
        toolCallId: "tc-client",
        output: { type: "json", value: null },
      }),
    ]);
  });

  test("errorText saves an error result the model sees", async () => {
    const t = createTest();
    const name = "error-text";
    const threadId = await t.action(api.clientTools.start, {
      name,
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
    });
    expect(next.prompt.at(-1).content[0]).toMatchObject({
      toolCallId: "tc-client",
      output: { type: "error-text", value: "Permission denied" },
    });
  });

  type Ctx = ReturnType<typeof createTest>;
  const output = (t: Ctx, threadId: string, tool = "getLocation") =>
    t.mutation(api.clientTools.addOutput, {
      threadId,
      tool,
      toolCallId: callIds[tool] ?? "tc-provider",
      output: { city: "Paris" },
    });
  // Past addToolOutput's tool check, as an app calling the component can.
  const componentOutput = (t: Ctx, threadId: string, tool: string) =>
    t.mutation(api.clientTools.readsOf, {
      kind: "mutation",
      name: "messages/respondToToolCallApprovals",
      args: {
        threadId,
        decisions: [],
        outputs: [
          {
            toolCallId: callIds[tool],
            toolName: tool,
            output: { type: "json", value: { city: "Paris" } },
          },
        ],
      },
    });
  type Rejection = [
    string,
    string[],
    (t: Ctx, threadId: string) => Promise<unknown>,
    RegExp,
  ];
  const rejections: Rejection[] = [
    [
      "a second output for the same call",
      ["getLocation"],
      async (t, threadId) => {
        await output(t, threadId);
        return output(t, threadId);
      },
      /Tool call tc-client was already handled/,
    ],
    [
      "an output after an approval",
      ["deleteFile"],
      async (t, threadId) => {
        await t.mutation(api.clientTools.decide, { threadId, approved: true });
        return componentOutput(t, threadId, "deleteFile");
      },
      /Tool call tc-delete was already handled/,
    ],
    [
      "an approval after a result",
      ["deleteFile"],
      async (t, threadId) => {
        await t.mutation(api.clientTools.saveOnFirstOrder, {
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
        });
        return t.mutation(api.clientTools.decide, { threadId, approved: true });
      },
      /Approval .* was already handled/,
    ],
    [
      "an output naming another client tool",
      ["getLocation"],
      (t, threadId) =>
        t.mutation(api.clientTools.addOutput, {
          threadId,
          tool: "askName",
          toolCallId: "tc-client",
          output: "done",
        }),
      /Tool call tc-client is a call to getLocation, not askName/,
    ],
    [
      "an output for a tool the agent doesn't have",
      ["getLocation"],
      (t, threadId) =>
        t.mutation(api.clientTools.addOutput, {
          threadId,
          tool: "nope",
          toolCallId: "tc-client",
          output: "done",
        }),
      /Tool nope is not in the agent's tools/,
    ],
    [
      "an output for a server tool",
      ["lookup"],
      (t, threadId) => output(t, threadId, "lookup"),
      /Tool lookup is not a client tool: it has execute/,
    ],
    [
      "an output for an agent's client tool left out of the tools passed",
      ["getLocation"],
      (t, threadId) =>
        t.mutation(api.clientTools.addOutput, {
          threadId,
          toolCallId: "tc-client",
          output: "done",
          tools: ["lookup"],
        }),
      /Tool getLocation is not in the tools passed/,
    ],
    [
      "an output for a call awaiting approval",
      ["deleteFile"],
      (t, threadId) => componentOutput(t, threadId, "deleteFile"),
      /Tool call tc-delete is awaiting approval/,
    ],
    [
      "an output for a provider-executed call",
      ["deleteFile"],
      async (t, threadId) => {
        await t.mutation(api.clientTools.saveOnFirstOrder, {
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
        });
        return t.mutation(api.clientTools.addOutput, {
          threadId,
          tool: "web_search",
          toolCallId: "tc-provider",
          output: {},
          tools: ["web_search"],
        });
      },
      /Tool call tc-provider is provider-executed/,
    ],
    [
      "an output for an unknown toolCallId",
      ["getLocation"],
      (t, threadId) =>
        t.mutation(api.clientTools.addOutput, {
          threadId,
          toolCallId: "nope",
          output: {},
        }),
      /Tool call nope was not found in the last 100 messages/,
    ],
  ];
  for (const [label, toolNames, act, error] of rejections) {
    test(`${label} is rejected`, async () => {
      const t = createTest();
      const threadId = await t.action(api.clientTools.start, {
        name: `reject-${label}`,
        toolNames,
      });
      await expect(act(t, threadId)).rejects.toThrow(error);
    });
  }

  test("the tools passed replace the agent's, as they do for a generation", async () => {
    const t = createTest();
    const threadId = await t.action(api.clientTools.start, {
      name: "per-call-tools",
    });
    await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client",
      output: { city: "Paris" },
      agentTools: ["lookup"],
      tools: ["getLocation"],
    });
    const { results } = await t.query(api.clientTools.messages, { threadId });
    expect(results).toEqual([
      expect.objectContaining({
        toolCallId: "tc-client",
        output: { type: "json", value: { city: "Paris" } },
      }),
    ]);
  });

  const movedPast: [string, (t: Ctx) => Promise<string>][] = [
    [
      "a generation without the client tool continued the step",
      async (t) => {
        const name = "without-client-tool";
        const threadId = await t.action(api.clientTools.start, {
          name,
        });
        const { docs } = await t.query(api.clientTools.messages, { threadId });
        await t.action(api.clientTools.cont, {
          name,
          threadId,
          promptMessageId: docs[0]._id,
          withoutClientTool: true,
        });
        return threadId;
      },
    ],
    [
      "a concurrent generation on its order is pending",
      (t) => t.mutation(api.clientTools.raceSteps, {}),
    ],
  ];
  for (const [label, setup] of movedPast) {
    test(`an output is rejected once ${label}`, async () => {
      const t = createTest();
      const threadId = await setup(t);
      await expect(output(t, threadId)).rejects.toThrow(
        /Tool call tc-client was not answered before its step continued/,
      );
    });
  }

  test("an output after a newer prompt is saved on its call's order and continues that order", async () => {
    const t = createTest();
    const name = "late-output";
    const threadId = await t.action(api.clientTools.start, {
      name,
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
    });
    expect(promptRoles(meanwhile.prompt)).toEqual(["user:text", "user:text"]);

    const { messageId } = await output(t, threadId);
    const late = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: messageId,
    });
    expect(promptRoles(late.prompt)).toEqual([
      "user:text",
      "assistant:tool-call",
      "tool:tool-result",
    ]);

    const thanks = await t.mutation(api.clientTools.saveUserMessage, {
      threadId,
      prompt: "Thanks",
    });
    const after = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: thanks.messageId,
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

  test("a step with two client calls continues from either output once both are saved", async () => {
    const t = createTest();
    const name = "two-client-calls";
    const threadId = await t.action(api.clientTools.start, {
      name,
      toolNames: ["getLocation", "getLocation:tc-client-2"],
    });
    const first = await output(t, threadId);
    await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client-2",
      output: { city: "Lyon" },
    });
    const next = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: first.messageId,
    });
    expect(next.text).toBe(PARIS);
    expectEveryCallAnsweredNext(next.prompt);
  });

  test("a step with a client call and an approved call continues from the output", async () => {
    const t = createTest();
    const name = "mixed-true-false";
    const threadId = await t.action(api.clientTools.start, {
      name,
      toolNames: ["getLocation", "deleteFile"],
    });
    await t.mutation(api.clientTools.decide, { threadId, approved: true });
    const { messageId } = await output(t, threadId);
    executed.length = 0;

    const next = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: messageId,
    });
    expect(next.text).toBe(PARIS);
    expect(executed).toEqual(["a.txt"]);
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
          output: { type: "text", value: "Deleted a.txt" },
        }),
      ]),
    );
  });

  test("a continuation that failed is retried from the same output", async () => {
    const t = createTest();
    const name = "failed-continuation";
    const threadId = await t.action(api.clientTools.start, {
      name,
    });
    const { messageId } = await output(t, threadId);
    await expect(
      t.action(api.clientTools.cont, {
        name,
        threadId,
        promptMessageId: messageId,
        failing: true,
      }),
    ).rejects.toThrow(/Mock error message/);
    const next = await t.action(api.clientTools.cont, {
      name,
      threadId,
      promptMessageId: messageId,
    });
    expect(next.text).toBe(PARIS);
    expectEveryCallAnsweredNext(next.prompt);
  });

  test("a client call in a stream that failed takes no output, and its step is retried", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());
    const t = createTest();
    const { threadId, promptMessageId } = await t.action(
      api.clientTools.failStep,
      {},
    );
    expect(error.mock.calls).toEqual([["Mock error message"]]);
    const failed = "0.1 failed assistant:tool-call";
    const rows = async () =>
      (await t.query(api.clientTools.messages, { threadId })).rows;
    expect(await rows()).toEqual(["0.0 success user:text", failed]);
    await expect(output(t, threadId)).rejects.toThrow(
      /Tool call tc-client was not found/,
    );
    const retried = await t.action(api.clientTools.cont, {
      name: "retry-error",
      threadId,
      promptMessageId,
      steps: [],
    });
    expect(retried.text).toBe(PARIS);
    expect(await rows()).toEqual([
      "0.0 success user:text",
      failed,
      "0.2 success assistant:text",
    ]);
  });
});
