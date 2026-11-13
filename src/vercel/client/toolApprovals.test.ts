import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
} from "@ai-sdk/provider";
import { stepCountIs, type ModelMessage, type ToolModelMessage } from "ai";
import { MockEmbeddingModelV4 } from "ai/test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod/v4";
import type { Message } from "../../validators.js";
import {
  Agent,
  createTool,
  docsToModelMessages,
  listMessages,
  saveMessage,
  type ContextHandler,
} from "../index.js";
import { MockLanguageModel, mockModel } from "./mockModel.js";
import { fetchContextWithPrompt } from "./search.js";
import { components, initConvexTest } from "./setup.test.js";
import type { ActionCtx } from "./types.js";

const executed: string[] = [];
const model = new MockLanguageModel({
  content: [{ type: "text", text: "Done" }],
});
const agent = new Agent(components.agent, {
  name: "batch-approval-test",
  languageModel: model,
  tools: {
    echo: createTool({
      inputSchema: z.object({ tag: z.string() }),
      needsApproval: true,
      execute: async (_ctx, { tag }) => {
        executed.push(tag);
        return tag;
      },
    }),
  },
});

type Decision = { approvalId: string; approved: boolean; reason?: string };
type ToolPart = ToolModelMessage["content"][number];
type AssistantPart = Exclude<
  Extract<ModelMessage, { role: "assistant" }>["content"],
  string
>[number];

function request(ids: string[], providerExecuted = false): Message {
  return {
    role: "assistant",
    content: ids.flatMap((approvalId) => [
      {
        type: "tool-call" as const,
        toolCallId: `call-${approvalId}`,
        toolName: "echo",
        input: { tag: approvalId },
        ...(providerExecuted ? { providerExecuted: true } : {}),
      },
      {
        type: "tool-approval-request" as const,
        toolCallId: `call-${approvalId}`,
        approvalId,
      },
    ]),
  };
}

// Ways an app's context handler can reshape the messages it is given.
type Part = ToolPart | AssistantPart;
type Handler = (messages: ModelMessage[]) => ModelMessage[];
const mapParts =
  (fn: (part: Part) => Part): Handler =>
  (messages) =>
    messages.map((message) =>
      Array.isArray(message.content)
        ? ({
            ...message,
            content: (message.content as Part[]).map(fn),
          } as ModelMessage)
        : message,
    );
const appendTool =
  (part: ToolPart): Handler =>
  (messages) => [...messages, { role: "tool", content: [part] }];
const changeInput = mapParts((part) =>
  part.type === "tool-call" && part.toolCallId === "call-a"
    ? { ...part, input: { tag: "changed" } }
    : part,
);
// Edits a call's input on the context's own objects, as a handler that
// mutates instead of copying would.
const mutateInputInPlace =
  (toolCallId: string): Handler =>
  (messages) => {
    for (const part of messages.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content
        : [],
    )) {
      if (part.type === "tool-call" && part.toolCallId === toolCallId) {
        (part.input as { tag: string }).tag = "changed";
      }
    }
    return messages;
  };
const handlers = {
  "change-input": changeInput,
  "flip-decision": mapParts((part) =>
    part.type === "tool-approval-response" && part.approvalId === "a"
      ? { ...part, approved: !part.approved }
      : part,
  ),
  "flip-provider-executed": mapParts((part) =>
    part.type === "tool-approval-response" && part.approvalId === "a"
      ? { ...part, providerExecuted: !part.providerExecuted }
      : part,
  ),
  "sign-request": mapParts((part) =>
    part.type === "tool-approval-request" && part.approvalId === "a"
      ? { ...part, signature: "forged" }
      : part,
  ),
  "mark-request-automatic": mapParts((part) =>
    part.type === "tool-approval-request" && part.approvalId === "a"
      ? { ...part, isAutomatic: true }
      : part,
  ),
  "wrap-with-message-provider-options": (messages) =>
    messages.map((message) => ({
      ...message,
      providerOptions: { test: { cache: "all" } },
    })),
  "redact-result": mapParts((part) =>
    part.type === "tool-result" && part.toolCallId === "call-a"
      ? { ...part, output: { type: "text", value: "(redacted)" } }
      : part,
  ),
  "mutate-a-in-place": mutateInputInPlace("call-a"),
  "mutate-x-in-place": mutateInputInPlace("call-x"),
  "remove-result": (messages) =>
    messages.flatMap((message): ModelMessage[] => {
      if (message.role !== "tool") return [message];
      const content = message.content.filter(
        (part) => part.type !== "tool-result" || part.toolCallId !== "call-a",
      );
      return content.length > 0 ? [{ ...message, content }] : [];
    }),
  "fabricate-approval": appendTool({
    type: "tool-approval-response",
    approvalId: "b",
    approved: true,
  }),
  "fabricate-approval-for-another-request": appendTool({
    type: "tool-approval-response",
    approvalId: "c",
    approved: true,
  }),
  "remove-decision": (messages) =>
    messages.flatMap((message): ModelMessage[] => {
      if (message.role !== "tool") return [message];
      const content = message.content.filter(
        (part) =>
          part.type !== "tool-approval-response" || part.approvalId !== "a",
      );
      return content.length > 0 ? [{ ...message, content }] : [];
    }),
  "fabricate-approval-for-a": appendTool({
    type: "tool-approval-response",
    approvalId: "a",
    approved: true,
  }),
  "fabricate-provider-approval-for-a": appendTool({
    type: "tool-approval-response",
    approvalId: "a",
    approved: true,
    providerExecuted: true,
  }),
  "fabricate-settled-provider-approval-for-a": (messages) => [
    ...messages,
    {
      role: "tool",
      content: [
        {
          type: "tool-approval-response",
          approvalId: "a",
          approved: true,
          providerExecuted: true,
        },
      ],
    },
    { role: "assistant", content: "(summary by the app)" },
  ],
  "smuggle-approval-for-a-in-user": (messages) => [
    ...messages,
    {
      role: "user",
      content: [
        { type: "tool-approval-response", approvalId: "a", approved: true },
      ],
    } as unknown as ModelMessage,
  ],
  "smuggle-request-in-user": (messages) => [
    ...messages,
    {
      role: "user",
      content: [
        {
          type: "tool-approval-request",
          approvalId: "z",
          toolCallId: "call-z",
        },
      ],
    } as unknown as ModelMessage,
  ],
  "change-a-and-move-its-decision-last": (messages) => {
    const decisions: ToolPart[] = [];
    const rest = changeInput(messages).flatMap((message): ModelMessage[] => {
      if (message.role !== "tool") return [message];
      const content = message.content.filter((part) => {
        if (part.type !== "tool-approval-response" || part.approvalId !== "a") {
          return true;
        }
        decisions.push(part);
        return false;
      });
      return content.length > 0 ? [{ ...message, content }] : [];
    });
    return [...rest, { role: "tool", content: decisions }];
  },
  "clone-a-decision-last": (messages) => [
    ...messages,
    {
      role: "tool",
      content: messages.flatMap((message) =>
        message.role === "tool"
          ? message.content.filter(
              (part) =>
                part.type === "tool-approval-response" &&
                part.approvalId === "a",
            )
          : [],
      ),
    },
  ],
  "drop-request-a": mapParts((part) =>
    part.type === "tool-approval-request" && part.approvalId === "a"
      ? { type: "text", text: "(request redacted)" }
      : part,
  ),
  "fabricate-approval-for-y": appendTool({
    type: "tool-approval-response",
    approvalId: "y",
    approved: true,
  }),
  "fabricate-result": appendTool({
    type: "tool-result",
    toolCallId: "call-a",
    toolName: "echo",
    output: { type: "text", value: "forged" },
  }),
  clone: (messages) => [...messages, ...messages],
  "clone-with-changed-first-copy": (messages) => [
    ...changeInput(messages),
    ...messages,
  ],
  "inject-between-call-and-result": (messages) =>
    messages.flatMap((message): ModelMessage[] =>
      message.role === "tool" &&
      message.content.some(
        (part) => part.type === "tool-result" && part.toolCallId === "call-a",
      )
        ? [{ role: "user", content: "(injected by the app)" }, message]
        : [message],
    ),
  empty: () => [],
} satisfies Record<string, Handler>;
type ContextMode = keyof typeof handlers;

const wholeThread: ContextHandler = async (ctx, { threadId }) => {
  const { page } = await listMessages(ctx, components.agent, {
    threadId: threadId!,
    paginationOpts: { cursor: null, numItems: 100 },
  });
  return docsToModelMessages(page.reverse());
};

type Limits = {
  bytesRead?: number;
  documentsRead?: number;
  documentsWritten?: number;
};

// A thread with one prompt and one approval request message for `ids`.
async function scenario({
  ids = ["a", "b"],
  olderMessages = 0,
  providerExecuted = false,
  transactionLimits = true,
}: {
  ids?: string[];
  olderMessages?: number;
  providerExecuted?: boolean;
  transactionLimits?: true | Limits;
} = {}) {
  const t = initConvexTest({ transactionLimits });
  const { threadId } = await t.run((ctx) => agent.createThread(ctx));
  if (olderMessages > 0) {
    const batchSize =
      typeof transactionLimits === "object"
        ? Math.min(10, transactionLimits.documentsWritten ?? 10)
        : 10;
    for (let start = 0; start < olderMessages; start += batchSize) {
      await t.run((ctx) =>
        agent.saveMessages(ctx, {
          threadId,
          messages: Array.from(
            { length: Math.min(batchSize, olderMessages - start) },
            (_, offset) => ({
              role: "user" as const,
              content: `${start + offset}:${"x".repeat(4_000)}`,
            }),
          ),
          skipEmbeddings: true,
        }),
      );
    }
  }
  const save = (
    args: { promptMessageId?: string } & (
      | { prompt: string; message?: undefined }
      | { prompt?: undefined; message: Message }
    ),
  ) =>
    t.run((ctx) =>
      agent.saveMessage(ctx, { ...args, threadId, skipEmbeddings: true }),
    );
  const { messageId: promptMessageId } = await save({
    prompt: "Run the tools",
  });
  const { messageId: requestMessageId } = await save({
    promptMessageId,
    message: request(ids, providerExecuted),
  });
  const messages = () =>
    t.run((ctx) =>
      agent.listMessages(ctx, {
        threadId,
        paginationOpts: { cursor: null, numItems: 200 },
      }),
    );
  const s = {
    t,
    threadId,
    requestMessageId,
    messages,
    save,
    async results() {
      return (await messages()).page.flatMap((stored) =>
        stored.message?.role === "tool"
          ? stored.message.content.filter((part) => part.type === "tool-result")
          : [],
      );
    },
    async resultIds() {
      return (await s.results()).map((part) => part.toolCallId).sort();
    },
    decide(decisions: Decision[]) {
      return t.run((ctx) =>
        agent.respondToToolCallApprovals(ctx, { threadId, decisions }),
      );
    },
    async approve(...ids: string[]) {
      const { messageId } = await s.decide(
        ids.map((approvalId) => ({ approvalId, approved: true })),
      );
      return messageId;
    },
    decideAndCatch(decisions: Decision[]) {
      return t.run(async (ctx) => {
        try {
          await agent.respondToToolCallApprovals(ctx, { threadId, decisions });
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      });
    },
    async addRequest(promptMessageId: string, ids: string[], pe = false) {
      await save({ promptMessageId, message: request(ids, pe) });
    },
    async prompt(text: string) {
      return (await save({ prompt: text })).messageId;
    },
    generate(
      args: {
        promptMessageId: string;
        messages?: ModelMessage[];
        prompt?: ModelMessage[];
      },
      contextHandler?: ContextHandler,
    ) {
      return t.action(async (ctx) => {
        const result = await agent.generateText(
          ctx,
          { threadId },
          args,
          contextHandler ? { contextHandler } : undefined,
        );
        return result.text;
      });
    },
    continue(promptMessageId: string, contextMode?: ContextMode) {
      return s.generate(
        { promptMessageId },
        contextMode
          ? async (_ctx, { allMessages }) => handlers[contextMode](allMessages)
          : undefined,
      );
    },
    // `a` approved and continued, `b` still open.
    async completeA() {
      const first = await s.approve("a");
      await s.continue(first);
      return first;
    },
    // completeA, then a second request `c` at the same order, approved.
    async completeAThenApproveC() {
      const first = await s.completeA();
      await s.addRequest(first, ["c"], providerExecuted);
      const newer = await s.approve("c");
      return { first, newer };
    },
  };
  return s;
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

function lastModelPrompt() {
  const prompt = model.doGenerateCalls.at(-1)?.prompt;
  expect(prompt).toBeDefined();
  return prompt ?? [];
}

function partsFor(id: string) {
  return lastModelPrompt().flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter(
          (part) =>
            ("toolCallId" in part && part.toolCallId === `call-${id}`) ||
            ("approvalId" in part && part.approvalId === id),
        )
      : [],
  );
}

function sentDecisions() {
  return model.doGenerateCalls.flatMap(({ prompt }) =>
    prompt.flatMap((message) =>
      message.role === "tool"
        ? message.content.flatMap((part) =>
            part.type === "tool-approval-response"
              ? [`${part.approvalId}:${part.approved}`]
              : [],
          )
        : [],
    ),
  );
}

// The model returns the provider's result for each call the prompt's last
// message decides, or for those of them in `only`.
function providerResults(only?: string[]) {
  const generate = model.doGenerate.bind(model);
  vi.spyOn(model, "doGenerate").mockImplementation(async (options) => {
    const last = options.prompt.at(-1);
    const decided =
      last?.role === "tool"
        ? last.content.flatMap((part) =>
            part.type === "tool-approval-response" &&
            (!only || only.includes(part.approvalId))
              ? [part.approvalId]
              : [],
          )
        : [];
    const result = await generate(options);
    if (decided.length === 0) return result;
    return {
      ...result,
      content: decided.flatMap((id): LanguageModelV4Content[] => [
        {
          type: "tool-call",
          toolCallId: `call-${id}`,
          toolName: "echo",
          input: JSON.stringify({ tag: id }),
          providerExecuted: true,
        },
        {
          type: "tool-result",
          toolCallId: `call-${id}`,
          toolName: "echo",
          result: "ran",
        },
      ]),
    };
  });
}

function callInputs(id: string) {
  return partsFor(id).flatMap((part) =>
    part.type === "tool-call" ? [part.input] : [],
  );
}

function expectNoDanglingLocalCalls() {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of lastModelPrompt()) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-call" && !part.providerExecuted) {
        calls.add(part.toolCallId);
      }
      if (part.type === "tool-result") results.add(part.toolCallId);
    }
  }
  expect([...calls].filter((id) => !results.has(id))).toEqual([]);
  expect([...results].filter((id) => !calls.has(id))).toEqual([]);
}

// Providers with strict turn ordering need each local call answered by the
// very next message, and a result must not be shown twice per call.
function expectEveryCallAnsweredNext() {
  const prompt = lastModelPrompt();
  for (const [i, message] of prompt.entries()) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const callIds = message.content.flatMap((part) =>
      part.type === "tool-call" && !part.providerExecuted
        ? [part.toolCallId]
        : [],
    );
    if (callIds.length === 0) continue;
    const next = prompt[i + 1];
    expect(next?.role).toBe("tool");
    const answered =
      next?.role === "tool"
        ? next.content.flatMap((part) =>
            part.type === "tool-result" ? [part.toolCallId] : [],
          )
        : [];
    for (const id of callIds) {
      expect(answered.filter((answeredId) => answeredId === id)).toHaveLength(
        1,
      );
    }
  }
}

afterEach(() => {
  executed.length = 0;
  model.doGenerateCalls.length = 0;
  vi.restoreAllMocks();
});

describe("tool approval semantics", () => {
  test("continues a mixed batch", async () => {
    const s = await scenario({ ids: ["a", "b", "c"] });
    const { messageId } = await s.decide([
      { approvalId: "a", approved: true },
      { approvalId: "b", approved: false, reason: "Not permitted" },
      { approvalId: "c", approved: true },
    ]);

    await s.continue(messageId);

    expect([...executed].sort()).toEqual(["a", "c"]);
    expectNoDanglingLocalCalls();
    const results = await s.results();
    expect(results).toHaveLength(3);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: "call-a" }),
        expect.objectContaining({
          toolCallId: "call-b",
          output: { type: "execution-denied", reason: "Not permitted" },
        }),
        expect.objectContaining({ toolCallId: "call-c" }),
      ]),
    );
  });

  test("combines separately submitted siblings before continuation", async () => {
    const s = await scenario();
    await s.approve("a");

    await s.continue(await s.approve("b"));

    expect([...executed].sort()).toEqual(["a", "b"]);
    expectNoDanglingLocalCalls();
    expect(await s.resultIds()).toEqual(["call-a", "call-b"]);
  });

  test("resumes a later sibling without repeating completed work", async () => {
    const s = await scenario();
    await s.completeA();
    expect(await s.resultIds()).toEqual(["call-a"]);

    await s.continue(await s.approve("b"));

    expect(executed).toEqual(["a", "b"]);
    expectNoDanglingLocalCalls();
    expect(await s.resultIds()).toEqual(["call-a", "call-b"]);
  });

  test("defers and later resumes an approval from an earlier partial continuation", async () => {
    const s = await scenario();
    const { newer } = await s.completeAThenApproveC();

    await s.continue(await s.approve("b"));
    expect(executed).toEqual(["a", "b"]);
    expect(partsFor("c")).toEqual([]);

    await s.continue(newer);
    expect(executed).toEqual(["a", "b", "c"]);
    expectNoDanglingLocalCalls();
  });

  test("a deferred provider-owned decision never reaches the provider", async () => {
    const s = await scenario({ providerExecuted: true });
    await s.completeAThenApproveC();

    await s.continue(await s.approve("b"));

    expect(partsFor("c")).toEqual([]);
  });

  test("a deferred provider-owned decision reaches the provider when resumed after a sibling's continuation", async () => {
    const s = await scenario({ providerExecuted: true });
    const { newer } = await s.completeAThenApproveC();
    await s.continue(await s.approve("b"));

    await s.continue(newer);

    expect(
      partsFor("c").filter((part) => part.type === "tool-approval-response"),
    ).toEqual([expect.objectContaining({ approvalId: "c", approved: true })]);
    expect(lastModelPrompt().at(-1)?.role).toBe("tool");
  });

  test("a provider-owned decision continued with a sibling's is not sent again by its own", async () => {
    const s = await scenario({ providerExecuted: true });
    const first = await s.approve("a");
    await s.continue(await s.approve("b"));
    expect(
      partsFor("a").filter((part) => part.type === "tool-approval-response"),
    ).toHaveLength(1);

    await s.continue(first);

    expect(
      partsFor("a").filter((part) => part.type === "tool-approval-response"),
    ).toEqual([]);
  });

  test("each provider-owned decision reaches the provider once when its siblings' continuations overlap", async () => {
    const s = await scenario({ providerExecuted: true });
    const first = await s.approve("a");
    const second = await s.approve("b");

    await s.continue(first);
    await s.continue(second);
    await s.continue(first);

    expect(sentDecisions().sort()).toEqual(["a:true", "b:true"]);
  });

  test.each(["a", "again"])(
    "rejects continuing %s when its call id is reused at the same order",
    async (approvalId) => {
      const s = await scenario({ ids: ["a"] });
      await s.save({
        promptMessageId: s.requestMessageId,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-a",
              toolName: "echo",
              input: { tag: "again" },
            },
            {
              type: "tool-approval-request",
              toolCallId: "call-a",
              approvalId: "again",
            },
          ],
        },
      });

      await expect(s.continue(await s.approve(approvalId))).rejects.toThrow(
        /more than one tool-call for call-a/,
      );
      expect(executed).toEqual([]);
    },
  );

  test("a provider-owned decision left pending past an unrelated prompt is sent once when resumed", async () => {
    const s = await scenario({ ids: ["a"], providerExecuted: true });
    const first = await s.approve("a");
    await s.generate({ promptMessageId: await s.prompt("Unrelated") });
    await s.continue(first);
    await s.continue(first);

    expect(sentDecisions()).toEqual(["a:true"]);
  });

  test("a provider-owned denial is sent once", async () => {
    const s = await scenario({ ids: ["a"], providerExecuted: true });
    const { messageId } = await s.decide([
      { approvalId: "a", approved: false, reason: "No" },
    ]);
    await s.continue(messageId);
    await s.continue(messageId);
    await s.generate({ promptMessageId: await s.prompt("Next") });

    expect(sentDecisions()).toEqual(["a:false"]);
  });

  test("a provider-owned request beside a local one at its order is sent once", async () => {
    const s = await scenario({ ids: ["a"] });
    await s.addRequest(s.requestMessageId, ["p"], true);
    const provider = await s.approve("p");
    await s.continue(await s.approve("a"));
    await s.continue(provider);
    await s.continue(provider);

    expect(executed).toEqual(["a"]);
    expect(sentDecisions()).toEqual(["p:true"]);
    expectNoDanglingLocalCalls();
  });

  test("a provider-owned continuation that saved only tool parts is not sent again without tool messages", async () => {
    const s = await scenario({ ids: ["a"], providerExecuted: true });
    const first = await s.approve("a");
    const generate = model.doGenerate.bind(model);
    vi.spyOn(model, "doGenerate").mockImplementationOnce(async (options) => ({
      ...(await generate(options)),
      content: [
        {
          type: "tool-call",
          toolCallId: "call-a",
          toolName: "echo",
          input: JSON.stringify({ tag: "a" }),
          providerExecuted: true,
        },
        {
          type: "tool-result",
          toolCallId: "call-a",
          toolName: "echo",
          result: "ran",
        },
      ],
    }));
    await s.continue(first);

    await s.t.action(async (ctx) => {
      await agent.generateText(
        ctx,
        { threadId: s.threadId },
        { promptMessageId: first },
        { contextOptions: { excludeToolMessages: true } },
      );
    });

    expect(sentDecisions()).toEqual(["a:true"]);
  });

  test("a provider-owned continuation records its decisions on one message", async () => {
    const s = await scenario({ ids: ["a", "b"], providerExecuted: true });
    providerResults(["a"]);

    await s.continue(await s.approve("a", "b"));

    expect(
      (await s.messages()).page.flatMap((stored) =>
        stored.continuedApprovalIds ? [stored.continuedApprovalIds] : [],
      ),
    ).toEqual([["a", "b"]]);
  });

  test("a local continuation records nothing", async () => {
    const s = await scenario();

    await s.continue(await s.approve("a", "b"));

    expect(
      (await s.messages()).page.filter(
        (stored) => stored.continuedApprovalIds !== undefined,
      ),
    ).toEqual([]);
  });

  test("an empty provider-owned continuation still settles its decision", async () => {
    const s = await scenario({ ids: ["a"], providerExecuted: true });
    const first = await s.approve("a");
    const generate = model.doGenerate.bind(model);
    vi.spyOn(model, "doGenerate").mockImplementationOnce(async (options) => ({
      ...(await generate(options)),
      content: [],
    }));

    await s.continue(first);
    await s.continue(first);

    expect(sentDecisions()).toEqual(["a:true"]);
  });

  test("fetchContextMessages leaves out an empty provider-owned continuation", async () => {
    const s = await scenario({ ids: ["a"], providerExecuted: true });
    const generate = model.doGenerate.bind(model);
    vi.spyOn(model, "doGenerate").mockImplementationOnce(async (options) => ({
      ...(await generate(options)),
      content: [],
    }));
    await s.continue(await s.approve("a"));

    const docs = await s.t.run((ctx) =>
      agent.fetchContextMessages(ctx, {
        threadId: s.threadId,
        userId: undefined,
        contextOptions: {},
      }),
    );

    expect(
      docs.filter(
        (doc) =>
          Array.isArray(doc.message?.content) &&
          doc.message.content.length === 0,
      ),
    ).toEqual([]);
  });

  test("re-running a completed continuation ignores a newer decided request", async () => {
    const s = await scenario();
    const { first } = await s.completeAThenApproveC();

    await s.continue(first);

    expect(executed).toEqual(["a"]);
    expect(partsFor("c")).toEqual([]);
    expectNoDanglingLocalCalls();
  });

  test("a completed request at the same order keeps its call and result together", async () => {
    const s = await scenario();
    const { newer } = await s.completeAThenApproveC();
    await s.continue(newer);

    await s.continue(await s.approve("b"));

    expect(executed).toEqual(["a", "c", "b"]);
    expectNoDanglingLocalCalls();
    expectEveryCallAnsweredNext();
  });

  // Only a stored result shows that an approved provider-executed call ran.
  test.each([true, false])(
    "a provider-owned approval answered on another request stays in history only with its result (result: %s)",
    async (withResult) => {
      const s = await scenario({ ids: ["provider"], providerExecuted: true });
      const first = await s.approve("provider");
      await s.continue(first);
      if (withResult) {
        await s.save({
          promptMessageId: first,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-provider",
                toolName: "echo",
                output: { type: "text", value: "ran" },
                providerExecuted: true,
              },
            ],
          },
        });
      }
      await s.addRequest(first, ["c"]);

      await s.continue(await s.approve("c"));

      expect(executed).toEqual(["c"]);
      expect(partsFor("provider").map((part) => part.type)).toEqual(
        withResult ? ["tool-call", "tool-result"] : [],
      );
    },
  );

  test("does not resubmit a completed provider-owned sibling", async () => {
    const s = await scenario({ providerExecuted: true });
    await s.completeA();

    await s.continue(await s.approve("b"));

    const approvalIds = lastModelPrompt().flatMap((message) =>
      message.role === "tool"
        ? message.content.flatMap((part) =>
            part.type === "tool-approval-response" ? [part.approvalId] : [],
          )
        : [],
    );
    expect(approvalIds).toEqual(["b"]);
    expect(lastModelPrompt().at(-1)?.role).toBe("tool");
  });

  test.each([true, false])(
    "keeps a provider-executed decision provider-owned (approved=%s)",
    async (approved) => {
      const s = await scenario({ ids: ["provider"], providerExecuted: true });
      const { messageId } = await s.decide([
        { approvalId: "provider", approved, reason: "Reviewed" },
      ]);

      await s.continue(messageId);

      expect(executed).toEqual([]);
      expect(partsFor("provider")).toContainEqual(
        expect.objectContaining({
          type: "tool-approval-response",
          approved,
          reason: "Reviewed",
        }),
      );
    },
  );

  test("records a substantial batch with one bounded read and one write", async () => {
    const ids = Array.from({ length: 24 }, (_, index) => `approval-${index}`);
    const olderMessages = 80;
    const s = await scenario({
      ids,
      olderMessages,
      transactionLimits: {
        bytesRead: 1_000_000,
        documentsRead: olderMessages + 20,
        documentsWritten: 1,
      },
    });

    await s.decide(
      ids.map((approvalId) => ({
        approvalId,
        approved: true,
        reason: "r".repeat(2_000),
      })),
    );

    const savedApprovalIds = (await s.messages()).page.flatMap((stored) =>
      stored.message?.role === "tool"
        ? stored.message.content.flatMap((part) =>
            part.type === "tool-approval-response" ? [part.approvalId] : [],
          )
        : [],
    );
    expect(savedApprovalIds.sort()).toEqual([...ids].sort());
  });

  test.each<[string, Decision[], RegExp]>([
    ["empty", [], /at least one|empty/i],
    [
      "missing",
      [
        { approvalId: "a", approved: true },
        { approvalId: "missing", approved: true },
      ],
      /not found/i,
    ],
    [
      "duplicate",
      [
        { approvalId: "a", approved: true },
        { approvalId: "a", approved: false },
      ],
      /duplicate/i,
    ],
    [
      "already-handled",
      [
        { approvalId: "a", approved: false },
        { approvalId: "b", approved: true },
      ],
      /already handled/i,
    ],
    [
      "different-request-message",
      [
        { approvalId: "a", approved: true },
        { approvalId: "c", approved: true },
      ],
      /same.*message|request message/i,
    ],
  ])("rejects an atomic invalid batch: %s", async (kind, decisions, error) => {
    const s = await scenario();
    if (kind === "already-handled") await s.approve("a");
    if (kind === "different-request-message") {
      await s.addRequest(s.requestMessageId, ["c"]);
    }
    const before = await s.messages();

    expect(await s.decideAndCatch(decisions)).toMatch(error);

    expect(await s.messages()).toEqual(before);
    expect(executed).toEqual([]);
  });

  // Request `a` at the first order ends up `earlier`, then a later order asks
  // for `ids`.
  type Earlier = "approved" | "denied" | "approved-not-continued" | "pending";
  async function laterOrder(s: Scenario, earlier: Earlier, ids = ["x"]) {
    if (earlier !== "pending") {
      const { messageId } = await s.decide([
        { approvalId: "a", approved: earlier !== "denied" },
      ]);
      if (earlier !== "approved-not-continued") await s.continue(messageId);
    }
    await s.addRequest(await s.prompt("Next"), ids);
  }

  test.each<[Earlier, boolean]>([
    ["approved", true],
    ["approved", false],
    ["denied", true],
    ["denied", false],
  ])(
    "continues a later order's approval after an earlier one completed (%s, then approved=%s)",
    async (earlier, approvedX) => {
      const s = await scenario({ ids: ["a"] });
      await laterOrder(s, earlier);
      const { messageId } = await s.decide([
        { approvalId: "x", approved: approvedX },
      ]);

      await s.continue(messageId);

      expect(executed).toEqual([
        ...(earlier === "approved" ? ["a"] : []),
        ...(approvedX ? ["x"] : []),
      ]);
      expect(await s.resultIds()).toEqual(["call-a", "call-x"]);
      expectNoDanglingLocalCalls();
      expectEveryCallAnsweredNext();
    },
  );

  test("continues a later order's approval after an earlier one was answered but never continued", async () => {
    const s = await scenario({ ids: ["a"] });
    await laterOrder(s, "approved-not-continued");

    await s.continue(await s.approve("x"));

    expect(executed).toEqual(["x"]);
    expect(await s.resultIds()).toEqual(["call-x"]);
    expectNoDanglingLocalCalls();
  });

  // `a` and then `x` at a later order are both approved and run, and the
  // continuation for `x` runs again with a context handler.
  test.each<ContextMode>([
    "change-a-and-move-its-decision-last",
    "clone-a-decision-last",
    "drop-request-a",
    "fabricate-provider-approval-for-a",
  ])(
    "rerunning a completed continuation runs nothing again: %s",
    async (contextMode) => {
      const s = await scenario({ ids: ["a"] });
      await laterOrder(s, "approved");
      const later = await s.approve("x");
      await s.continue(later);

      await s.continue(later, contextMode);

      expect(executed).toEqual(["a", "x"]);
      expectNoDanglingLocalCalls();
    },
  );

  test("a provider-owned decision that ran is not sent again, whatever the handler returns", async () => {
    const s = await scenario({ providerExecuted: true });
    await s.completeA();

    await s.continue(await s.approve("b"), "flip-decision");

    expect(
      partsFor("a").filter((part) => part.type === "tool-approval-response"),
    ).toEqual([]);
  });

  test.each<[ContextMode, Earlier, boolean]>([
    ["flip-decision", "denied", false],
    ["remove-decision", "approved", false],
    ["fabricate-approval-for-a", "pending", false],
    ["fabricate-provider-approval-for-a", "pending", true],
    ["fabricate-settled-provider-approval-for-a", "pending", true],
    ["fabricate-approval-for-y", "approved", false],
    ["smuggle-approval-for-a-in-user", "denied", false],
    ["smuggle-approval-for-a-in-user", "pending", false],
    ["smuggle-request-in-user", "approved", false],
  ])(
    "only the continued decision runs, whatever the handler returns: %s (earlier %s)",
    async (contextMode, earlier, providerExecuted) => {
      const s = await scenario({ ids: ["a"], providerExecuted });
      await laterOrder(s, earlier, ["x", "y"]);
      const before = [...executed];

      await s.continue(await s.approve("x"), contextMode);

      expect(executed).toEqual([...before, "x"]);
      expect(partsFor("y")).toEqual([]);
      if (earlier === "pending") expect(partsFor("a")).toEqual([]);
      expectNoDanglingLocalCalls();
    },
  );

  test.each([
    ["a different", "reviewed"],
    ["the same", "a"],
  ])(
    "rejects continuing an approval whose call id was reused with %s input",
    async (_name, tag) => {
      const s = await scenario({ ids: ["a"] });
      const later = await s.prompt("Again");
      await s.save({
        promptMessageId: later,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-a",
              toolName: "echo",
              input: { tag },
            },
            {
              type: "tool-approval-request",
              toolCallId: "call-a",
              approvalId: "reviewed",
            },
          ],
        },
      });

      await expect(s.continue(await s.approve("reviewed"))).rejects.toThrow(
        /more than one tool-call for call-a/,
      );
      expect(executed).toEqual([]);
    },
  );

  test("a request that reuses a completed call's id is left out, and cannot be continued", async () => {
    const s = await scenario({ ids: ["a"] });
    await s.completeA();
    const later = await s.prompt("Again");
    await s.save({
      promptMessageId: later,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-a",
            toolName: "echo",
            input: { tag: "again" },
          },
          {
            type: "tool-approval-request",
            toolCallId: "call-a",
            approvalId: "again",
          },
        ],
      },
    });

    await s.generate({ promptMessageId: await s.prompt("Unrelated") });
    expect(callInputs("a")).toEqual([{ tag: "a" }]);
    expectEveryCallAnsweredNext();

    await expect(s.continue(await s.approve("again"))).rejects.toThrow(
      /more than one tool-call for call-a/,
    );
    expect(executed).toEqual(["a"]);
  });

  test("a pending local request that reuses a provider call's id is left out", async () => {
    const s = await scenario({ ids: ["a"], providerExecuted: true });
    const first = await s.approve("a");
    await s.continue(first);
    await s.save({
      promptMessageId: first,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-a",
            toolName: "echo",
            output: { type: "text", value: "ran" },
            providerExecuted: true,
          },
        ],
      },
    });
    await s.save({
      promptMessageId: await s.prompt("Again"),
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-a",
            toolName: "echo",
            input: { tag: "local" },
          },
          {
            type: "tool-approval-request",
            toolCallId: "call-a",
            approvalId: "local",
          },
        ],
      },
    });

    expect(await s.generate({ promptMessageId: await s.prompt("Next") })).toBe(
      "Done",
    );
    expect(callInputs("a")).toEqual([{ tag: "a" }]);
  });

  test("rejects a stored context that decides one approval id twice", async () => {
    const s = await scenario({ ids: ["a"] });
    await s.continue(await s.approve("a"));
    const later = await s.prompt("Again");
    await s.save({
      promptMessageId: later,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-again",
            toolName: "echo",
            input: { tag: "again" },
          },
          {
            type: "tool-approval-request",
            toolCallId: "call-again",
            approvalId: "a",
          },
        ],
      },
    });

    await expect(s.continue(await s.approve("a"))).rejects.toThrow(
      /more than one tool-approval-request for approval a/,
    );
    expect(executed).toEqual(["a"]);
  });

  test("rejects a response message that answers another order's request", async () => {
    const s = await scenario();
    const later = await s.prompt("Next");
    await s.addRequest(later, ["x"]);
    const { messageId } = await s.save({
      promptMessageId: later,
      message: {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "x", approved: true },
          { type: "tool-approval-response", approvalId: "a", approved: true },
        ],
      },
    });

    await expect(s.continue(messageId)).rejects.toThrow(
      /one complete request message/,
    );
    expect(executed).toEqual([]);
  });

  // A context handler may return any history, but what a continuation runs
  // comes from storage. Shapes: "pending" has `a` approved but not run;
  // "completed" has `a` run and `b` approved; "with another request" has `a`
  // approved and a second request `c` at the order.
  type Shape = "pending" | "completed" | "with-another-request";
  async function shaped(s: Scenario, shape: Shape) {
    if (shape === "pending") return s.approve("a");
    if (shape === "completed") {
      await s.completeA();
      return s.approve("b");
    }
    const first = await s.approve("a");
    await s.addRequest(first, ["c"]);
    return first;
  }

  test.each<[ContextMode, Shape]>([
    ["change-input", "pending"],
    ["flip-decision", "pending"],
    ["flip-provider-executed", "pending"],
    ["sign-request", "pending"],
    ["mark-request-automatic", "pending"],
    ["fabricate-result", "pending"],
    ["remove-decision", "pending"],
    ["empty", "pending"],
    ["fabricate-approval", "with-another-request"],
    ["fabricate-approval-for-another-request", "with-another-request"],
    ["clone-with-changed-first-copy", "completed"],
    ["remove-result", "completed"],
  ])(
    "a context handler cannot change what a continuation runs: %s (%s)",
    async (contextMode, shape) => {
      const s = await scenario();
      const messageId = await shaped(s, shape);
      const continued = shape === "completed" ? "b" : "a";

      await s.continue(messageId, contextMode);

      expect(executed).toEqual(shape === "completed" ? ["a", "b"] : ["a"]);
      expect(callInputs(continued)).toEqual([{ tag: continued }]);
      expect(partsFor("c")).toEqual([]);
      if (shape !== "completed") expect(partsFor("b")).toEqual([]);
      expectNoDanglingLocalCalls();
    },
  );

  test.each<ContextMode>([
    "clone",
    "inject-between-call-and-result",
    "fabricate-result",
  ])(
    "a reshaped context still answers each call once: %s",
    async (contextMode) => {
      const s = await scenario();
      await s.completeA();

      await s.continue(await s.approve("b"), contextMode);

      expect(executed).toEqual(["a", "b"]);
      expect(await s.resultIds()).toEqual(["call-a", "call-b"]);
      expectEveryCallAnsweredNext();
    },
  );

  test.each([true, false])(
    "a handler may redact an approved call's result (at an earlier order: %s)",
    async (earlier) => {
      const s = await scenario(earlier ? { ids: ["a"] } : {});
      let messageId: string;
      if (earlier) {
        await laterOrder(s, "approved");
        messageId = await s.approve("x");
      } else {
        await s.completeA();
        messageId = await s.approve("b");
      }

      await s.continue(messageId, "redact-result");

      expect(executed).toEqual(["a", earlier ? "x" : "b"]);
      expect(partsFor("a")).toContainEqual(
        expect.objectContaining({
          type: "tool-result",
          output: { type: "text", value: "(redacted)" },
        }),
      );
      expectEveryCallAnsweredNext();
    },
  );

  test.each(["a", "x"])(
    "a handler that edits call-%s's input in place does not change what runs",
    async (id) => {
      const s = await scenario({ ids: ["a"] });
      await laterOrder(s, "approved");

      await s.continue(
        await s.approve("x"),
        id === "a" ? "mutate-a-in-place" : "mutate-x-in-place",
      );

      expect(executed).toEqual(["a", "x"]);
      expect(callInputs("x")).toEqual([{ tag: "x" }]);
    },
  );

  test("the continued approvals follow the handler's messages", async () => {
    const s = await scenario();
    await s.completeA();

    await s.continue(
      await s.approve("b"),
      "wrap-with-message-provider-options",
    );

    expect(executed).toEqual(["a", "b"]);
    const prompt = lastModelPrompt();
    for (const message of prompt.slice(0, -2)) {
      expect(message.providerOptions).toEqual({ test: { cache: "all" } });
    }
    expect(prompt.slice(-2).map((message) => message.role)).toEqual([
      "assistant",
      "tool",
    ]);
    expect(partsFor("b").map((part) => part.type)).toEqual([
      "tool-call",
      "tool-result",
    ]);
  });

  test("the handler sees the fetched context, approval requests and decisions included", async () => {
    const s = await scenario({ ids: ["a", "b", "c"] });
    await s.completeA();
    let seen: ModelMessage[] = [];

    await s.generate(
      { promptMessageId: await s.approve("b") },
      async (_ctx, { allMessages }) => {
        seen = structuredClone(allMessages);
        return allMessages;
      },
    );

    const types = (id: string) =>
      seen.flatMap((message) =>
        Array.isArray(message.content)
          ? (message.content as Part[]).flatMap((part) =>
              ("toolCallId" in part && part.toolCallId === `call-${id}`) ||
              ("approvalId" in part && part.approvalId === id)
                ? [part.type]
                : [],
            )
          : [],
      );
    expect(types("a")).toEqual([
      "tool-call",
      "tool-approval-request",
      "tool-approval-response",
      "tool-result",
    ]);
    expect(types("b")).toEqual([
      "tool-call",
      "tool-approval-request",
      "tool-approval-response",
    ]);
    expect(types("c")).toEqual(["tool-call", "tool-approval-request"]);
    expect(executed).toEqual(["a", "b"]);
    expect(partsFor("c")).toEqual([]);
  });

  test("caller messages cannot approve a sibling", async () => {
    const s = await scenario();
    const before = (await s.messages()).page.length;

    await expect(
      s.generate({
        promptMessageId: await s.approve("a"),
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "tool-approval-response",
                approvalId: "b",
                approved: true,
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/Approval b is not stored/);

    expect(executed).toEqual([]);
    expect(model.doGenerateCalls).toEqual([]);
    expect((await s.messages()).page).toHaveLength(before + 1);
  });

  test.each([
    ["messages", "a thread"],
    ["messages", "no thread"],
    ["prompt", "a thread"],
    ["prompt", "no thread"],
  ] as const)(
    "a decision passed in %s that is not stored throws, with %s",
    async (field, where) => {
      const t = initConvexTest({ transactionLimits: true });
      const threadId =
        where === "a thread"
          ? (await t.run((ctx) => agent.createThread(ctx))).threadId
          : undefined;
      const history: ModelMessage[] = [
        { role: "user", content: "Run the tools" },
        request(["a"]) as ModelMessage,
        {
          role: "tool",
          content: [
            { type: "tool-approval-response", approvalId: "a", approved: true },
          ],
        },
      ];

      await expect(
        t.action((ctx) =>
          agent.generateText(
            ctx,
            threadId ? { threadId } : { userId: "user" },
            field === "messages" ? { messages: history } : { prompt: history },
          ),
        ),
      ).rejects.toThrow(
        "Approval a is not stored. Save decisions with approveToolCall, denyToolCall or respondToToolCallApprovals, then continue from the returned messageId.",
      );

      expect(executed).toEqual([]);
      expect(model.doGenerateCalls).toEqual([]);
      if (threadId) {
        const { page } = await t.run((ctx) =>
          agent.listMessages(ctx, {
            threadId,
            paginationOpts: { cursor: null, numItems: 10 },
          }),
        );
        expect(page).toEqual([]);
      }
    },
  );

  test("an unstored decision throws before the prompt is embedded", async () => {
    const doEmbed = vi.fn(async () => ({
      embeddings: [Array(1536).fill(0.1)],
      warnings: [],
    }));
    const embedding = new Agent(components.agent, {
      ...agent.options,
      embeddingModel: new MockEmbeddingModelV4({ doEmbed }),
    });
    const s = await scenario({ ids: ["a"] });
    const promptMessageId = (await s.messages()).page.find(
      (stored) => stored.message?.role === "user",
    )!._id;

    await expect(
      s.t.action((ctx) =>
        embedding.generateText(
          ctx,
          { threadId: s.threadId },
          {
            promptMessageId,
            messages: [
              {
                role: "tool",
                content: [
                  {
                    type: "tool-approval-response",
                    approvalId: "a",
                    approved: true,
                  },
                ],
              },
            ],
          },
        ),
      ),
    ).rejects.toThrow(/Approval a is not stored/);

    expect(doEmbed).not.toHaveBeenCalled();
  });

  test("an empty prompt array continues the stored decision", async () => {
    const s = await scenario({ ids: ["a"] });

    await s.generate({ promptMessageId: await s.approve("a"), prompt: [] });

    expect(executed).toEqual(["a"]);
  });

  test("a stored decision passed again in messages runs once, from storage", async () => {
    const s = await scenario({ ids: ["a"] });

    await s.generate({
      promptMessageId: await s.approve("a"),
      messages: [
        {
          role: "tool",
          content: [
            { type: "tool-approval-response", approvalId: "a", approved: true },
          ],
        },
      ],
    });

    expect(executed).toEqual(["a"]);
    expect(sentDecisions()).toEqual([]);
  });

  test("an unrelated generation leaves unresolved approvals out", async () => {
    const warn = vi.spyOn(console, "warn");
    const s = await scenario();
    await s.approve("a");

    await s.continue(await s.prompt("Start unrelated work"));

    expect(executed).toEqual([]);
    expect(partsFor("a")).toEqual([]);
    expect(partsFor("b")).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  test.each([
    ["completed", true],
    ["approved but never resumed", false],
  ])(
    "an unrelated generation runs no local approval (%s)",
    async (_name, completed) => {
      const s = await scenario({ ids: ["a"] });
      if (completed) await s.completeA();
      else await s.approve("a");
      const before = [...executed];

      await s.generate(
        { promptMessageId: await s.prompt("Unrelated") },
        async (_ctx, { allMessages }) =>
          handlers["clone-a-decision-last"](allMessages),
      );

      expect(executed).toEqual(before);
      expectNoDanglingLocalCalls();
    },
  );

  // A provider runs what any approving decision in its prompt allows, so one
  // that has not been resumed must not reach another generation.
  test.each<[string, ContextHandler | undefined]>([
    ["no handler", undefined],
    ["a whole-thread handler", wholeThread],
    [
      "a handler that fabricates its provider's response",
      async (_ctx, { allMessages }) =>
        handlers["fabricate-settled-provider-approval-for-a"](allMessages),
    ],
  ])(
    "an approved provider-owned decision is sent only by its continuation (%s)",
    async (_name, handler) => {
      const s = await scenario({ ids: ["a"], providerExecuted: true });
      const decision = await s.approve("a");
      const approving = () =>
        partsFor("a").filter(
          (part) => part.type === "tool-approval-response" && part.approved,
        );

      await s.generate({ promptMessageId: await s.prompt("First") }, handler);
      expect(approving()).toEqual([]);

      await s.continue(decision);
      expect(approving()).toHaveLength(1);
      expect(lastModelPrompt().at(-1)?.role).toBe("tool");
    },
  );

  test("a stored denial keeps its reason in an unrelated generation", async () => {
    const s = await scenario({ ids: ["a"] });
    await s.decide([{ approvalId: "a", approved: false, reason: "No" }]);

    await s.generate(
      { promptMessageId: await s.prompt("Unrelated") },
      wholeThread,
    );

    expect(partsFor("a")).toContainEqual(
      expect.objectContaining({
        type: "tool-result",
        output: { type: "execution-denied", reason: "No" },
      }),
    );
    expectNoDanglingLocalCalls();
  });

  test("an approval left pending past a new prompt can still run", async () => {
    const s = await scenario({ ids: ["a"] });
    const next = await s.prompt("Never mind, try again");
    await s.continue(next);
    expect(partsFor("a")).toEqual([]);
    await s.addRequest(next, ["again"]);

    await s.continue(await s.approve("again"));
    expect(executed).toEqual(["again"]);
    expect(partsFor("a")).toEqual([]);

    await s.continue(await s.approve("a"));
    expect(executed).toEqual(["again", "a"]);
    expectNoDanglingLocalCalls();
  });
});

// https://github.com/convex/agent/issues/411
describe("a context handler that returns the whole thread", () => {
  type Prompt = LanguageModelV4CallOptions["prompt"];
  const render = (prompt: Prompt) =>
    prompt.map(
      (message) =>
        `${message.role}: ${
          typeof message.content === "string"
            ? message.content
            : message.content
                .map((part) =>
                  part.type === "text"
                    ? part.text
                    : `${part.type}:${"toolCallId" in part ? part.toolCallId : ""}`,
                )
                .join(" ")
        }`,
    );
  const turn = (n: number, done: boolean) => [
    `user: Delete file-${n}.txt`,
    `assistant: tool-call:call-${n}`,
    `tool: tool-result:call-${n}`,
    ...(done ? [`assistant: Deleted file-${n}.txt`] : []),
  ];

  async function approvals({
    turns,
    recentMessages,
    excludeToolMessages = false,
    first = "approve",
  }: {
    turns: number;
    recentMessages: number;
    excludeToolMessages?: boolean;
    first?: "approve" | "decline" | "leave pending";
  }) {
    const reply = (content: LanguageModelV4Content) => ({
      content: [content],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    });
    const steps = Array.from({ length: turns }, (_, i) => i + 1).flatMap(
      (n) => [
        reply({
          type: "tool-call",
          toolCallId: `call-${n}`,
          toolName: "deleteFile",
          input: JSON.stringify({ name: `file-${n}.txt` }),
        }),
        ...(n === 1 && first === "leave pending"
          ? []
          : [reply({ type: "text", text: `Deleted file-${n}.txt` })]),
      ],
    );
    const prompts: Prompt[] = [];
    const deleted: string[] = [];
    const component = components.agent;
    const repro = new Agent(component, {
      name: "repro",
      languageModel: new MockLanguageModel({
        doGenerate: async ({ prompt }) => {
          prompts.push(prompt);
          return steps.shift()!;
        },
        doStream: async () => {
          throw new Error("unused");
        },
      }),
      tools: {
        deleteFile: createTool({
          inputSchema: z.object({ name: z.string() }),
          needsApproval: true,
          execute: async (_ctx, { name }) => {
            deleted.push(name);
            return `deleted ${name}`;
          },
        }),
      },
      contextOptions: { recentMessages, excludeToolMessages },
      contextHandler: wholeThread,
    });
    const t = initConvexTest();
    const { threadId } = await t.run((ctx) => repro.createThread(ctx));
    for (let n = 1; n <= turns; n++) {
      const declined = first === "decline" && n === 1;
      const approvalId = await t.action(async (ctx) => {
        const { messageId } = await saveMessage(ctx, component, {
          threadId,
          prompt: `Delete file-${n}.txt`,
        });
        const result = await repro.generateText(
          ctx,
          { threadId },
          { promptMessageId: messageId },
        );
        return result.content.find(
          (part) => part.type === "tool-approval-request",
        )!.approvalId;
      });
      if (first === "leave pending" && n === 1) continue;
      const { messageId } = await t.run((ctx) =>
        declined
          ? repro.denyToolCall(ctx, { threadId, approvalId })
          : repro.approveToolCall(ctx, { threadId, approvalId }),
      );
      const text = await t.action(async (ctx) => {
        const result = await repro.generateText(
          ctx,
          { threadId },
          { promptMessageId: messageId },
        );
        return result.text;
      });
      expect(text).toBe(`Deleted file-${n}.txt`);
      expect(deleted.filter((name) => name === `file-${n}.txt`)).toHaveLength(
        declined ? 0 : 1,
      );
      expect(render(prompts.at(-1)!)).toEqual([
        ...(first === "leave pending" ? ["user: Delete file-1.txt"] : []),
        ...Array.from({ length: n - 1 }, (_, i) => turn(i + 1, true))
          .flat()
          .slice(first === "leave pending" ? 4 : 0),
        ...turn(n, false),
      ]);
    }
    expect(deleted).toHaveLength(first === "approve" ? turns : turns - 1);
  }

  test.each([1, 3])(
    "continues every approval over 3 turns with recentMessages: %i",
    (recentMessages) => approvals({ turns: 3, recentMessages }),
  );

  test("continues every approval with excludeToolMessages", () =>
    approvals({ turns: 3, recentMessages: 1, excludeToolMessages: true }));

  test("continues later approvals after the first was declined", () =>
    approvals({ turns: 3, recentMessages: 1, first: "decline" }));

  test("continues later approvals while the first is still pending", () =>
    approvals({ turns: 3, recentMessages: 1, first: "leave pending" }));
});

describe("signed tool approvals", () => {
  const secret = "approval-secret";

  test.each<[string, string, boolean]>([
    ["the same secret and a whole-thread handler", secret, true],
    ["another secret", "another-secret", false],
  ])("a continuation with %s", async (_name, continueSecret, whole) => {
    const ran: string[] = [];
    const signing = new Agent(components.agent, {
      name: "signed-approval",
      tools: {
        echo: createTool({
          inputSchema: z.object({ tag: z.string() }),
          needsApproval: true,
          execute: async (_ctx, { tag }) => {
            ran.push(tag);
            return tag;
          },
        }),
      },
      languageModel: mockModel({
        contentSteps: [
          [
            {
              type: "tool-call",
              toolCallId: "call-x",
              toolName: "echo",
              input: JSON.stringify({ tag: "x" }),
            },
          ],
          [{ type: "text", text: "Done" }],
        ],
      }),
    });
    const t = initConvexTest();
    const { threadId, approvalId } = await t.action(async (ctx) => {
      const { threadId } = await signing.createThread(ctx);
      const result = await signing.generateText(
        ctx,
        { threadId },
        { prompt: "Echo x", experimental_toolApprovalSecret: secret },
      );
      const request = result.content.find(
        (part) => part.type === "tool-approval-request",
      );
      return { threadId, approvalId: request!.approvalId };
    });
    const { messageId } = await t.run((ctx) =>
      signing.approveToolCall(ctx, { threadId, approvalId }),
    );

    const resume = t.action(async (ctx) => {
      const result = await signing.generateText(
        ctx,
        { threadId },
        {
          promptMessageId: messageId,
          experimental_toolApprovalSecret: continueSecret,
        },
        whole ? { contextHandler: wholeThread } : undefined,
      );
      return result.text;
    });

    if (continueSecret === secret) {
      expect(await resume).toBe("Done");
      expect(ran).toEqual(["x"]);
    } else {
      await expect(resume).rejects.toThrow(/signature/);
      expect(ran).toEqual([]);
    }
  });
});

describe("approval continuation with excludeToolMessages", () => {
  function setup() {
    const ran: string[] = [];
    const excludingAgent = new Agent(components.agent, {
      name: "exclude-tool-messages-approval",
      contextOptions: { excludeToolMessages: true },
      stopWhen: stepCountIs(5),
      tools: {
        echo: createTool({
          inputSchema: z.object({ tag: z.string() }),
          needsApproval: true,
          execute: async (_ctx, { tag }) => {
            ran.push(tag);
            return tag;
          },
        }),
      },
      languageModel: mockModel({
        contentSteps: [
          [
            {
              type: "tool-call",
              toolCallId: "call-x",
              toolName: "echo",
              input: JSON.stringify({ tag: "x" }),
            },
          ],
          [{ type: "text", text: "Done" }],
        ],
      }),
    });
    return { ran, excludingAgent, t: initConvexTest() };
  }

  test.each(["generateText", "streamText"] as const)(
    "%s runs the approved tool",
    async (mode) => {
      const { ran, excludingAgent, t } = setup();
      const { threadId, approvalId } = await t.action(async (ctx) => {
        const { threadId } = await excludingAgent.createThread(ctx);
        const first = await excludingAgent.generateText(
          ctx,
          { threadId },
          { prompt: "Echo x" },
        );
        const approvalId = first.steps
          .flatMap((step) => step.content)
          .flatMap((part) =>
            part.type === "tool-approval-request" ? [part.approvalId] : [],
          )[0];
        return { threadId, approvalId };
      });
      expect(approvalId).toBeDefined();
      const { messageId } = await t.run((ctx) =>
        excludingAgent.approveToolCall(ctx, { threadId, approvalId }),
      );

      const text = await t.action(async (ctx) => {
        if (mode === "generateText") {
          return (
            await excludingAgent.generateText(
              ctx,
              { threadId },
              { promptMessageId: messageId },
            )
          ).text;
        }
        const result = await excludingAgent.streamText(
          ctx,
          { threadId },
          { promptMessageId: messageId },
        );
        await result.consumeStream();
        return await result.text;
      });

      expect(ran).toEqual(["x"]);
      expect(text).toBe("Done");
    },
  );
});

// Read costs per call, pinned so a change shows up here. Local approvals read
// what main reads; a provider-owned continuation adds its record to one
// message.
describe("approval read costs", () => {
  type Reads = [documentsRead: number, bytesRead: number, queries: number];
  const reads = async (ctx: { meta: unknown }): Promise<Reads> => {
    const { documentsRead, bytesRead, databaseQueries } = await (
      ctx.meta as {
        getTransactionMetrics(): Promise<
          Record<
            "documentsRead" | "bytesRead" | "databaseQueries",
            { used: number }
          >
        >;
      }
    ).getTransactionMetrics();
    return [documentsRead.used, bytesRead.used, databaseQueries.used];
  };

  test.each<[string, boolean, boolean, Record<string, Reads>]>([
    [
      "local",
      false,
      false,
      {
        "respond a": [7, 3054, 15],
        "context a": [4, 1626, 3],
        "respond b": [10, 4379, 15],
        "context b": [7, 2937, 3],
        "respond c": [13, 5690, 15],
        "context c": [10, 4248, 3],
        "context next": [13, 5379, 3],
      },
    ],
    [
      "provider-owned with results",
      true,
      true,
      {
        "respond a": [7, 3234, 15],
        "context a": [4, 1716, 3],
        "respond b": [9, 4580, 15],
        "context b": [6, 2945, 3],
        "respond c": [11, 5809, 15],
        "context c": [8, 4174, 3],
        "context next": [10, 5187, 3],
      },
    ],
    [
      "provider-owned without results",
      true,
      false,
      {
        "respond a": [7, 3234, 15],
        "context a": [4, 1716, 3],
        "respond b": [9, 4188, 15],
        "context b": [6, 2704, 3],
        "respond c": [11, 5176, 15],
        "context c": [8, 3692, 3],
        "context next": [10, 4464, 3],
      },
    ],
  ])(
    "deciding and continuing siblings one at a time: %s",
    async (_name, providerExecuted, results, expected) => {
      if (results) providerResults();
      const s = await scenario({ ids: ["a", "b", "c"], providerExecuted });
      const measured: Record<string, Reads> = {};
      const context = (promptMessageId: string, label: string) =>
        s.t.run(async (ctx) => {
          await fetchContextWithPrompt(
            ctx as unknown as ActionCtx,
            components.agent,
            {
              ...agent.options,
              prompt: undefined,
              messages: undefined,
              promptMessageId,
              userId: undefined,
              threadId: s.threadId,
            },
          );
          measured[label] = await reads(ctx);
        });
      for (const approvalId of ["a", "b", "c"]) {
        const messageId = await s.t.run(async (ctx) => {
          const { messageId } = await agent.respondToToolCallApprovals(ctx, {
            threadId: s.threadId,
            decisions: [{ approvalId, approved: true }],
          });
          measured[`respond ${approvalId}`] = await reads(ctx);
          return messageId;
        });
        await context(messageId, `context ${approvalId}`);
        await s.continue(messageId);
      }
      await context(await s.prompt("Next"), "context next");

      expect(measured).toEqual(expected);
    },
  );
});
