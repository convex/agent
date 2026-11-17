import { describe, expect, test } from "vitest";
import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { stepCountIs, tool } from "ai";
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
    stream: v.boolean(),
    steps: v.optional(v.array(v.array(v.string()))),
    withoutClientTool: v.optional(v.boolean()),
    failing: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    {
      name,
      threadId,
      promptMessageId,
      stream,
      steps,
      withoutClientTool,
      failing,
    },
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
    let text: string;
    if (stream) {
      const result = await agent.streamText(ctx, { threadId }, args, {
        saveStreamDeltas: { chunking: "word", throttleMs: 0 },
      });
      await result.consumeStream();
      text = await result.text;
    } else {
      text = (await agent.generateText(ctx, { threadId }, args)).text;
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
    toolNames: v.array(v.string()),
    mode: v.union(v.literal("error"), v.literal("abort")),
  },
  handler: async (ctx, { toolNames, mode }) => {
    const agent = new Agent(components.agent, {
      name: `failing-${toolNames.join("-")}-${mode}`,
      tools,
      stopWhen: stepCountIs(5),
      languageModel: mockModel({
        contentSteps: [
          toolNames.map((name) =>
            name === "lookup"
              ? { ...toolCall(name), input: JSON.stringify({ q: mode }) }
              : toolCall(name),
          ),
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

// The component functions a generation calls and the documents each reads,
// for an agent with or without the client tool. With a promptMessageId it
// continues that thread.
const generationCalls = app.action({
  args: {
    withClientTool: v.boolean(),
    threadId: v.optional(v.string()),
    promptMessageId: v.optional(v.string()),
  },
  handler: async (ctx, { withClientTool, threadId, promptMessageId }) => {
    const agent = new Agent(components.agent, {
      name: "calls",
      tools: withClientTool ? { getLocation, lookup } : { lookup },
      stopWhen: stepCountIs(5),
      languageModel: mockModel({
        content:
          withClientTool && !promptMessageId
            ? [toolCall("getLocation")]
            : [{ type: "text", text: PARIS }],
      }),
    });
    const calls: string[] = [];
    const measure = makeFunctionReference<"mutation">("clientTools:readsOf");
    const record =
      (kind: "query" | "mutation") => async (ref: any, args: any) => {
        const name = String(ref[Symbol.for("toReferencePath")]).replace(
          "_reference/childComponent/agent/",
          "",
        );
        const { result, documents } = await ctx.runMutation(measure, {
          kind,
          name,
          args,
        });
        calls.push(`${kind} ${name} reads ${documents}`);
        return result;
      };
    const recording = {
      ...ctx,
      runQuery: record("query") as typeof ctx.runQuery,
      runMutation: record("mutation") as typeof ctx.runMutation,
    };
    threadId ??= (await agent.createThread(ctx, {})).threadId;
    await agent.generateText(
      recording,
      { threadId },
      promptMessageId ? { promptMessageId } : { prompt: "Where?" },
    );
    return { threadId, calls };
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
// finishes. The first saves a client call; the second saves text or is still
// pending.
const raceSteps = app.mutation({
  args: { secondPending: v.boolean() },
  handler: async (ctx, { secondPending }) => {
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
          ],
        },
      ],
    });
    if (!secondPending) {
      await saveMessages(ctx, components.agent, {
        threadId,
        pendingMessageId: second,
        messages: [{ role: "assistant", content: "Moving on." }],
      });
    }
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
    generationCalls,
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

  type Ctx = ReturnType<typeof createTest>;
  const output = (t: Ctx, threadId: string, tool = "getLocation") =>
    t.mutation(api.clientTools.addOutput, {
      threadId,
      tool,
      toolCallId: callIds[tool] ?? "tc-provider",
      output: { city: "Paris" },
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
    ...[true, false].map(
      (approved): Rejection => [
        `an output after ${approved ? "an approval" : "a denial"}`,
        ["deleteFile"],
        async (t: Ctx, threadId: string) => {
          await t.mutation(api.clientTools.decide, { threadId, approved });
          return output(t, threadId, "deleteFile");
        },
        /Tool call tc-delete was already handled/,
      ],
    ),
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
      "an output naming another tool",
      ["getLocation"],
      (t, threadId) =>
        t.mutation(api.clientTools.addOutput, {
          threadId,
          tool: "deleteFile",
          toolCallId: "tc-client",
          output: "done",
        }),
      /Tool call tc-client is a call to getLocation, not deleteFile/,
    ],
    [
      "an output for a call awaiting approval",
      ["deleteFile"],
      (t, threadId) => output(t, threadId, "deleteFile"),
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
        return output(t, threadId, "web_search");
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
        stream: false,
        toolNames,
      });
      await expect(act(t, threadId)).rejects.toThrow(error);
    });
  }

  const movedPast: [string, (t: Ctx) => Promise<string>][] = [
    [
      "a generation without the client tool continued the step",
      async (t) => {
        const name = "without-client-tool";
        const threadId = await t.action(api.clientTools.start, {
          name,
          stream: false,
        });
        const { docs } = await t.query(api.clientTools.messages, { threadId });
        await t.action(api.clientTools.cont, {
          name,
          threadId,
          promptMessageId: docs[0]._id,
          stream: false,
          withoutClientTool: true,
        });
        return threadId;
      },
    ],
    [
      "text was saved by hand on its order",
      async (t) => {
        const threadId = await t.action(api.clientTools.start, {
          name: "by-hand",
          stream: false,
        });
        await t.mutation(api.clientTools.saveOnFirstOrder, {
          threadId,
          message: { role: "assistant", content: "Moving on." },
        });
        return threadId;
      },
    ],
    ...[false, true].map(
      (secondPending): [string, (t: Ctx) => Promise<string>] => [
        `a concurrent generation on its order ${secondPending ? "is pending" : "saved text"}`,
        (t) => t.mutation(api.clientTools.raceSteps, { secondPending }),
      ],
    ),
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

    const { messageId } = await output(t, threadId);
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

  test("a step with two client calls continues from either output once both are saved", async () => {
    const t = createTest();
    const name = "two-client-calls";
    const threadId = await t.action(api.clientTools.start, {
      name,
      stream: false,
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
      stream: false,
    });
    expect(next.text).toBe(PARIS);
    expectEveryCallAnsweredNext(next.prompt);
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
        const decision = () =>
          t.mutation(api.clientTools.decide, { threadId, approved });
        const { messageId } = outputFirst
          ? (await output(t, threadId), await decision())
          : (await decision(), await output(t, threadId));
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

  test("a continuation that failed is retried from the same output", async () => {
    const t = createTest();
    const name = "failed-continuation";
    const threadId = await t.action(api.clientTools.start, {
      name,
      stream: false,
    });
    const { messageId } = await output(t, threadId);
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

  for (const [toolNames, mode] of [
    [["getLocation"], "error"],
    [["getLocation", "lookup"], "abort"],
  ] as const) {
    test(`a client call in a stream that ${mode === "error" ? "failed" : "was aborted during a server tool"} takes no output, and its step is retried`, async () => {
      const t = createTest();
      const { threadId, promptMessageId } = await t.action(
        api.clientTools.failStep,
        { toolNames: [...toolNames], mode },
      );
      const failed = `0.1 failed assistant:${toolNames.map(() => "tool-call").join(",")}`;
      const rows = async () =>
        (await t.query(api.clientTools.messages, { threadId })).rows;
      expect(await rows()).toEqual(["0.0 success user:text", failed]);
      await expect(output(t, threadId)).rejects.toThrow(
        /Tool call tc-client was not found/,
      );
      const retried = await t.action(api.clientTools.cont, {
        name: `retry-${mode}`,
        threadId,
        promptMessageId,
        stream: false,
        steps: [],
      });
      expect(retried.text).toBe(PARIS);
      expect(await rows()).toEqual([
        "0.0 success user:text",
        failed,
        "0.2 success assistant:text",
      ]);
    });
  }
});

describe("component calls and reads per generation", () => {
  // Measured on main at a3321497, before client tools. The continuation is
  // from a result saved by hand on its call's order, as main documented.
  const firstTurn = [
    "query messages/listMessagesByThreadId reads 0",
    "mutation messages/addMessages reads 3",
    "mutation messages/addMessages reads 7",
  ];
  const continuation = [
    "query messages/listMessagesByThreadId reads 4",
    "mutation messages/addMessages reads 5",
    "mutation messages/addMessages reads 8",
  ];

  for (const withClientTool of [false, true]) {
    test(`a generation ${withClientTool ? "that calls a client tool" : "without client tools"} makes the same calls and reads as before client tools`, async () => {
      const { calls } = await createTest().action(
        api.clientTools.generationCalls,
        { withClientTool },
      );
      expect(calls).toEqual(firstTurn);
    });
  }

  test("a continuation from addToolOutput makes the same calls and reads as one from a result saved by hand on main", async () => {
    const t = createTest();
    const { threadId } = await t.action(api.clientTools.generationCalls, {
      withClientTool: true,
    });
    const { messageId } = await t.mutation(api.clientTools.addOutput, {
      threadId,
      toolCallId: "tc-client",
      output: { city: "Paris" },
    });
    const { calls } = await t.action(api.clientTools.generationCalls, {
      withClientTool: true,
      threadId,
      promptMessageId: messageId,
    });
    expect(calls).toEqual(continuation);
  });
});
