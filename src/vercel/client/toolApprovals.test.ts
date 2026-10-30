import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
} from "@ai-sdk/provider";
import { stepCountIs, type ModelMessage, type ToolModelMessage } from "ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod/v4";
import type { Message } from "../../validators.js";
import {
  Agent,
  createTool,
  docsToModelMessages,
  listMessages,
  saveMessage,
  toUIMessages,
  type ContextHandler,
} from "../index.js";
import { MockLanguageModel, mockModel } from "./mockModel.js";
import { components, initConvexTest } from "./setup.test.js";

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
const handlers = {
  "change-input": mapParts((part) =>
    part.type === "tool-call" && part.toolCallId === "call-a"
      ? { ...part, input: { tag: "changed" } }
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
  "inject-between-call-and-result": (messages) =>
    messages.flatMap((message): ModelMessage[] =>
      message.role === "tool" &&
      message.content.some(
        (part) => part.type === "tool-result" && part.toolCallId === "call-a",
      )
        ? [{ role: "user", content: "(injected by the app)" }, message]
        : [message],
    ),
  "result-before-call": (messages) => {
    const isResult = (message: ModelMessage) =>
      message.role === "tool" &&
      message.content.some(
        (part) => part.type === "tool-result" && part.toolCallId === "call-a",
      );
    return messages
      .filter((message) => !isResult(message))
      .flatMap((message): ModelMessage[] =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) => part.type === "tool-call" && part.toolCallId === "call-a",
        )
          ? [...messages.filter(isResult), message]
          : [message],
      );
  },
  "fabricate-settled-provider-approval": (messages) => [
    ...messages,
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-q",
          toolName: "echo",
          input: { tag: "q" },
          providerExecuted: true,
        },
        {
          type: "tool-approval-request",
          approvalId: "a",
          toolCallId: "call-q",
        },
      ],
    },
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
    { role: "assistant", content: "Done" },
  ],
  empty: () => [],
  clone: (messages) => [...messages, ...messages],
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
    promptMessageId,
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
    async toolStates() {
      return toUIMessages((await messages()).page)
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool-echo")
        .map((part) => (part as { state: string }).state);
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
      args: { promptMessageId: string; messages?: ModelMessage[] },
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
function expectEveryCallAnsweredNext(
  prompt: { role: string; content: unknown }[] = lastModelPrompt(),
) {
  for (const [i, message] of prompt.entries()) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const callIds = (message.content as Part[]).flatMap((part) =>
      part.type === "tool-call" && !part.providerExecuted
        ? [part.toolCallId]
        : [],
    );
    if (callIds.length === 0) continue;
    const next = prompt[i + 1];
    expect(next?.role).toBe("tool");
    const answered = Array.isArray(next?.content)
      ? (next.content as Part[]).flatMap((part) =>
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

  test.each([false, true])(
    "siblings continued separately each answer their call in later context (whole-thread handler: %s)",
    async (whole) => {
      const s = await scenario();
      const handler = whole ? wholeThread : undefined;
      await s.completeA();
      await s.generate({ promptMessageId: await s.approve("b") }, handler);

      await s.generate(
        { promptMessageId: await s.prompt("What happened?") },
        handler,
      );

      expect(executed).toEqual(["a", "b"]);
      expectNoDanglingLocalCalls();
      expectEveryCallAnsweredNext();
    },
  );

  test.each([false, true])(
    "an approved provider-owned decision stays out of unrelated generations until continued (whole-thread handler: %s)",
    async (whole) => {
      const s = await scenario({ ids: ["a"], providerExecuted: true });
      const handler = whole ? wholeThread : undefined;
      const decision = await s.approve("a");

      await s.generate({ promptMessageId: await s.prompt("First") }, handler);
      await s.generate({ promptMessageId: await s.prompt("Second") }, handler);
      expect(partsFor("a")).toEqual([]);

      await s.continue(decision);
      expect(partsFor("a").map((part) => part.type)).toContain(
        "tool-approval-response",
      );
    },
  );

  test("a handler cannot replay a provider-owned decision it fabricates", async () => {
    const s = await scenario({ ids: ["a"], providerExecuted: true });

    await s.continue(
      await s.prompt("Next"),
      "fabricate-settled-provider-approval",
    );

    expect(
      lastModelPrompt().flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter(
              (part) => part.type === "tool-approval-response",
            )
          : [],
      ),
    ).toEqual([]);
  });

  // The SDK takes a decision in the prompt's last message as a fresh one.
  test.each([
    [
      "a newer pending request",
      async (s: Scenario, first: string) => {
        await s.addRequest(first, ["c"], true);
        return s.continue(first);
      },
    ],
    [
      "a handler that trims its response",
      async (s: Scenario, first: string) => {
        await s.continue(first);
        return s.generate({ promptMessageId: first }, async (_ctx, args) =>
          args.allMessages.filter(
            (message) =>
              message.role !== "assistant" ||
              (Array.isArray(message.content) &&
                message.content.some((part) => part.type !== "text")),
          ),
        );
      },
    ],
  ])(
    "re-running a completed provider-owned continuation followed by %s sends no fresh decision",
    async (_name, rerun) => {
      const s = await scenario({ ids: ["a"], providerExecuted: true });

      await rerun(s, await s.approve("a"));

      expect(partsFor("c")).toEqual([]);
      const last = lastModelPrompt().at(-1);
      expect(
        Array.isArray(last?.content) &&
          last.content.some((part) => part.type === "tool-approval-response"),
      ).toBe(false);
    },
  );

  test("a consumed provider-owned decision on another request stays in history", async () => {
    const s = await scenario({ ids: ["provider"], providerExecuted: true });
    const first = await s.approve("provider");
    await s.continue(first);
    await s.addRequest(first, ["c"]);

    await s.continue(await s.approve("c"));

    expect(executed).toEqual(["c"]);
    expect(
      partsFor("provider").filter((part) => part.type === "tool-call"),
    ).toHaveLength(1);
  });

  test("does not resubmit a completed provider-owned sibling", async () => {
    const s = await scenario({ providerExecuted: true });
    await s.completeA();

    await s.continue(await s.approve("b"));

    const approvalIdsByToolMessage = lastModelPrompt().flatMap((message) =>
      message.role === "tool"
        ? [
            message.content.flatMap((part) =>
              part.type === "tool-approval-response" ? [part.approvalId] : [],
            ),
          ]
        : [],
    );
    expect(approvalIdsByToolMessage.slice(0, -1).flat()).toContain("a");
    expect(approvalIdsByToolMessage.at(-1)).toEqual(["b"]);
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

  test("approvals decided at different orders each run only from their own continuation", async () => {
    const s = await scenario({ ids: ["a"] });
    await laterOrder(s, "pending", ["x", "y"]);
    const earlier = await s.approve("a");

    await s.continue(await s.approve("x"));
    expect(executed).toEqual(["x"]);
    expect(partsFor("a")).toEqual([]);
    expect(partsFor("y")).toEqual([]);

    await s.continue(earlier);
    expect(executed).toEqual(["x", "a"]);
    expect(partsFor("x")).toEqual([]);

    await s.continue(await s.approve("y"));
    expect(executed).toEqual(["x", "a", "y"]);
    expect(await s.resultIds()).toEqual(["call-a", "call-x", "call-y"]);
    expectNoDanglingLocalCalls();
    expectEveryCallAnsweredNext();
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

  test("rejects a stored context with two decisions for the continued approval", async () => {
    const s = await scenario({ ids: ["a"] });
    const messageId = await s.approve("a");
    await s.save({
      promptMessageId: s.promptMessageId,
      message: {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "a", approved: true },
        ],
      },
    });

    await expect(s.continue(messageId)).rejects.toThrow(
      /more than one tool-approval-response for approval a/,
    );
    expect(executed).toEqual([]);
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
    for (const message of prompt.slice(-2)) {
      expect(message.providerOptions).toBeUndefined();
    }
    expect(partsFor("b").map((part) => part.type)).toEqual([
      "tool-call",
      "tool-result",
    ]);
  });

  test("an approved but un-continued approval does not run from an ordinary generation", async () => {
    const s = await scenario();
    await s.approve("a");

    await s.generate({ promptMessageId: s.promptMessageId });

    expect(executed).toEqual([]);
    expect(partsFor("a")).toEqual([]);
    expect(partsFor("b")).toEqual([]);
  });

  test("an unrelated generation leaves a pending approval out of context, and it runs once approved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await scenario({ ids: ["a"] });

    await s.generate({ promptMessageId: await s.prompt("Never mind") });

    expect(partsFor("a")).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(await s.toolStates()).toEqual(["approval-requested"]);

    await s.continue(await s.approve("a"));

    expect(executed).toEqual(["a"]);
    expect(await s.resultIds()).toEqual(["call-a"]);
  });

  // Whatever a context handler returns, only stored decisions run, with their
  // stored input, and each at most once.
  test.each<[ContextMode, boolean]>([
    ["fabricate-approval-for-a", false],
    ["fabricate-provider-approval-for-a", true],
    ["fabricate-approval-for-y", false],
    ["smuggle-approval-for-a-in-user", false],
    ["smuggle-request-in-user", false],
  ])(
    "a handler cannot approve another order's request: %s",
    async (contextMode, providerExecuted) => {
      const s = await scenario({ ids: ["a"], providerExecuted });
      await laterOrder(s, "pending", ["x", "y"]);

      await s.continue(await s.approve("x"), contextMode);

      expect(executed).toEqual(["x"]);
      expect(partsFor("a")).toEqual([]);
      expect(partsFor("y")).toEqual([]);
    },
  );

  test.each<ContextMode>([
    "fabricate-result",
    "fabricate-approval",
    "fabricate-approval-for-another-request",
  ])(
    "a handler cannot approve or answer a sibling: %s",
    async (contextMode) => {
      const s = await scenario();
      const first = await s.approve("a");
      await s.addRequest(first, ["c"]);

      await s.continue(first, contextMode);

      expect(executed).toEqual(["a"]);
      expect(await s.resultIds()).toEqual(["call-a"]);
      expect(partsFor("a")).not.toContainEqual(
        expect.objectContaining({ output: { type: "text", value: "forged" } }),
      );
    },
  );

  test("caller messages cannot approve a sibling", async () => {
    const s = await scenario();

    await s.generate({
      promptMessageId: await s.approve("a"),
      messages: [
        {
          role: "tool",
          content: [
            { type: "tool-approval-response", approvalId: "b", approved: true },
          ],
        },
      ],
    });

    expect(executed).toEqual(["a"]);
  });

  test("the continued call runs with its stored input when the handler returns nothing", async () => {
    const s = await scenario();

    await s.continue(await s.approve("a"), "empty");

    expect(executed).toEqual(["a"]);
    expect(callInputs("a")).toEqual([{ tag: "a" }]);
  });

  test("a handler may edit a completed call's history", async () => {
    const s = await scenario();
    await s.completeA();

    await s.continue(await s.approve("b"), "change-input");

    expect(executed).toEqual(["a", "b"]);
    expect(callInputs("a")).toEqual([{ tag: "changed" }]);
    expectEveryCallAnsweredNext();
  });

  test.each<ContextMode>([
    "clone",
    "fabricate-result",
    "inject-between-call-and-result",
  ])(
    "a reshaped completed history still answers each call once: %s",
    async (contextMode) => {
      const s = await scenario();
      await s.completeA();

      await s.continue(await s.approve("b"), contextMode);

      expect(executed).toEqual(["a", "b"]);
      expect(await s.resultIds()).toEqual(["call-a", "call-b"]);
      expectEveryCallAnsweredNext();
    },
  );

  // The SDK runs the continued approvals before it validates the prompt.
  test.each<ContextMode>(["remove-result", "result-before-call"])(
    "a completed call the handler leaves unanswered fails before anything runs: %s",
    async (contextMode) => {
      const s = await scenario();
      await s.completeA();

      await expect(
        s.continue(await s.approve("b"), contextMode),
      ).rejects.toThrow(/call-a without its result/);

      expect(executed).toEqual(["a"]);
      expect(await s.resultIds()).toEqual(["call-a"]);
    },
  );

  test("the handler sees no approval protocol or pending call", async () => {
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

    const parts = seen.flatMap((message) =>
      Array.isArray(message.content) ? (message.content as Part[]) : [],
    );
    expect(
      parts.filter(
        (part) =>
          part.type === "tool-approval-request" ||
          part.type === "tool-approval-response",
      ),
    ).toEqual([]);
    expect(
      parts.flatMap((part) => ("toolCallId" in part ? [part.toolCallId] : [])),
    ).toEqual(["call-a", "call-a"]);
    expectEveryCallAnsweredNext(seen);
    expect(executed).toEqual(["a", "b"]);
  });
});

// https://github.com/get-convex/agent/issues/411
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
    first = "approve",
  }: {
    turns: number;
    recentMessages: number;
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
      contextOptions: { recentMessages },
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
      const sent = render(prompts.at(-1)!);
      expect(sent).toEqual([
        ...(first === "leave pending" ? ["user: Delete file-1.txt"] : []),
        ...Array.from({ length: n - 1 }, (_, i) => turn(i + 1, true))
          .flat()
          .slice(first === "leave pending" ? 4 : 0),
        ...turn(n, false),
      ]);
      expect(sent.filter((line) => line.includes("approval"))).toEqual([]);
      expect(new Set(sent).size).toBe(sent.length);
    }
    expect(deleted).toHaveLength(first === "approve" ? turns : turns - 1);
  }

  test.each([1, 3])(
    "continues every approval over 3 turns with recentMessages: %i",
    (recentMessages) => approvals({ turns: 3, recentMessages }),
  );

  test("continues later approvals after the first was declined", () =>
    approvals({ turns: 3, recentMessages: 1, first: "decline" }));

  test("continues later approvals while the first is still pending", () =>
    approvals({ turns: 3, recentMessages: 1, first: "leave pending" }));
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
