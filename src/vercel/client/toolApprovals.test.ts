import type { ModelMessage, ToolModelMessage } from "ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod/v4";
import type { Message } from "../../validators.js";
import {
  Agent,
  createTool,
  type ContextHandler,
  type ContextOptions,
} from "../index.js";
import { MockLanguageModel } from "./mockModel.js";
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
// Each anchor part gets its own message with its own message-level options.
const splitWithOptions =
  (role: "assistant" | "tool", anchor: Part["type"]): Handler =>
  (messages) =>
    messages.flatMap((message): ModelMessage[] => {
      if (message.role !== role || !Array.isArray(message.content)) {
        return [message];
      }
      const content = message.content as Part[];
      const anchors = content.filter((part) => part.type === anchor);
      if (anchors.length < 2) return [message];
      return anchors.map((part, i) => {
        const id = "toolCallId" in part ? part.toolCallId : undefined;
        return {
          role,
          content: [
            part,
            ...content.filter(
              (other) =>
                other.type === "tool-approval-request" &&
                other.toolCallId === id,
            ),
          ],
          providerOptions: { test: { cache: `slot-${i}` } },
        } as ModelMessage;
      });
    });
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
  "add-call-provider-options": mapParts((part) =>
    part.type === "tool-call" && part.toolCallId === "call-a"
      ? { ...part, providerOptions: { test: { trace: "allowed" } } }
      : part,
  ),
  "wrap-with-message-provider-options": (messages) =>
    messages.map((message) => ({
      ...message,
      providerOptions: { test: { cache: "all" } },
    })),
  "cache-last-message": (messages) =>
    messages.map((message, i) =>
      i === messages.length - 1
        ? { ...message, providerOptions: { test: { cache: "last" } } }
        : message,
    ),
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
  "split-calls-with-message-provider-options": splitWithOptions(
    "assistant",
    "tool-call",
  ),
  "split-responses-with-message-provider-options": splitWithOptions(
    "tool",
    "tool-approval-response",
  ),
} satisfies Record<string, Handler>;
type ContextMode = keyof typeof handlers;

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
    continue(
      promptMessageId: string,
      contextMode?: ContextMode,
      contextOptions?: ContextOptions,
    ) {
      return t.action(async (ctx) => {
        const contextHandler: ContextHandler | undefined = contextMode
          ? async (_ctx, { allMessages }) => handlers[contextMode](allMessages)
          : undefined;
        const result = await agent.generateText(
          ctx,
          { threadId },
          { promptMessageId },
          { contextHandler, contextOptions },
        );
        return result.text;
      });
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
  test.each([false, true])(
    "executes an approved tool with excludeToolMessages=%s",
    async (excludeToolMessages) => {
      const s = await scenario({ ids: ["a"] });
      const { messageId } = await s.t.run((ctx) =>
        agent.approveToolCall(ctx, { threadId: s.threadId, approvalId: "a" }),
      );

      await s.continue(messageId, undefined, { excludeToolMessages });

      expect(executed).toEqual(["a"]);
      expect(await s.resultIds()).toEqual(["call-a"]);
      expectNoDanglingLocalCalls();
    },
  );

  test("excludes older tool history while continuing an approved exchange", async () => {
    const s = await scenario({ ids: ["old"] });
    await s.continue(await s.approve("old"));
    const promptMessageId = await s.prompt("Run another tool");
    await s.addRequest(promptMessageId, ["a"]);

    await s.continue(await s.approve("a"), undefined, {
      excludeToolMessages: true,
    });

    expect(executed).toEqual(["old", "a"]);
    expect(partsFor("old")).toEqual([]);
    expectNoDanglingLocalCalls();
  });

  test.each(["before", "after"] as const)(
    "recovers an approved exchange with over 1,000 same-order messages %s the decision",
    async (position) => {
      const s = await scenario({ ids: ["a"] });
      const addMessages = async () => {
        for (let start = 0; start < 1_001; start += 100) {
          await s.t.run((ctx) =>
            agent.saveMessages(ctx, {
              threadId: s.threadId,
              promptMessageId: s.requestMessageId,
              messages: Array.from(
                { length: Math.min(100, 1_001 - start) },
                () => ({
                  role: "assistant" as const,
                  content: "Still working",
                }),
              ),
              skipEmbeddings: true,
            }),
          );
        }
      };
      const approvalId = position === "before" ? "b" : "a";
      if (position === "before") {
        await s.completeA();
        await addMessages();
        await s.addRequest(s.requestMessageId, [approvalId]);
      }
      const { messageId } = await s.t.run((ctx) =>
        agent.approveToolCall(ctx, { threadId: s.threadId, approvalId }),
      );
      if (position === "after") {
        await s.addRequest(messageId, ["c"]);
        await s.approve("c");
        await addMessages();
      }

      await s.continue(messageId, undefined, { excludeToolMessages: true });

      expect(executed).toEqual(position === "before" ? ["a", "b"] : ["a"]);
      expect(await s.resultIds()).toEqual([`call-${approvalId}`]);
      expect(partsFor("c")).toEqual([]);
      if (position === "before") {
        expect(partsFor("a").map((part) => part.type)).toEqual([
          "tool-call",
          "tool-result",
        ]);
      }
      expectNoDanglingLocalCalls();
      expectEveryCallAnsweredNext();
    },
  );

  test("does not execute denied or unanswered tools with tool messages excluded", async () => {
    const s = await scenario({ ids: ["a", "b", "c"] });
    const { messageId } = await s.decide([
      { approvalId: "a", approved: true },
      { approvalId: "b", approved: false, reason: "Not permitted" },
    ]);

    await s.continue(messageId, undefined, { excludeToolMessages: true });

    expect(executed).toEqual(["a"]);
    expect(await s.results()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "call-b",
          output: { type: "execution-denied", reason: "Not permitted" },
        }),
      ]),
    );
    expectNoDanglingLocalCalls();
  });

  test("still validates approved inputs when tool messages are excluded", async () => {
    const s = await scenario({ ids: ["a"] });

    await expect(
      s.continue(await s.approve("a"), "change-input", {
        excludeToolMessages: true,
      }),
    ).rejects.toThrow(/preserve the stored tool-call for call-a/);

    expect(executed).toEqual([]);
  });

  test("does not restore approvals from another thread", async () => {
    const s = await scenario({ ids: ["a"] });
    const promptMessageId = await s.approve("a");
    const { threadId } = await s.t.run((ctx) => agent.createThread(ctx));

    await expect(
      s.t.action((ctx) =>
        agent.generateText(
          ctx,
          { threadId },
          { promptMessageId },
          { contextOptions: { excludeToolMessages: true } },
        ),
      ),
    ).rejects.toThrow(/thread/);

    expect(executed).toEqual([]);
  });

  test("does not restore a non-approval tool message", async () => {
    const s = await scenario({ ids: ["a"] });
    await s.continue(await s.approve("a"));
    const result = (await s.messages()).page.find(
      (doc) =>
        doc.message?.role === "tool" &&
        doc.message.content.some((part) => part.type === "tool-result"),
    );
    expect(result).toBeDefined();

    await s.continue(result!._id, undefined, { excludeToolMessages: true });

    expect(executed).toEqual(["a"]);
    expect(partsFor("a")).toEqual([]);
  });

  test("does not restore approval context when the prompt is overridden", async () => {
    const s = await scenario({ ids: ["a"] });
    const promptMessageId = await s.approve("a");

    await s.t.action(async (ctx) => {
      const result = await agent.generateText(
        ctx,
        { threadId: s.threadId },
        { promptMessageId, prompt: "Do something else" },
        { contextOptions: { excludeToolMessages: true } },
      );
      return result.text;
    });

    expect(executed).toEqual([]);
    expect(partsFor("a")).toEqual([]);
  });

  test("restores only the continued request within its message order", async () => {
    const s = await scenario();
    const { first } = await s.completeAThenApproveC();

    await s.continue(first, undefined, { excludeToolMessages: true });

    expect(executed).toEqual(["a"]);
    expect(partsFor("c")).toEqual([]);
    expectNoDanglingLocalCalls();
  });

  test("rejects an excluded decision for a request from another order", async () => {
    const s = await scenario();
    const later = await s.prompt("Next");
    await s.addRequest(later, ["x"]);
    const { messageId } = await s.save({
      promptMessageId: later,
      message: {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "a", approved: true },
        ],
      },
    });

    await expect(
      s.continue(messageId, undefined, { excludeToolMessages: true }),
    ).rejects.toThrow(/one complete request message/);

    expect(executed).toEqual([]);
  });

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

  // `a` and then `x` at a later order are both approved and run, and the
  // continuation for `x` runs again with a context handler.
  async function rerunLaterOrder(contextMode: ContextMode) {
    const s = await scenario({ ids: ["a"] });
    await laterOrder(s, "approved");
    const later = await s.approve("x");
    await s.continue(later);
    return s.continue(later, contextMode);
  }

  test("rejects changing an earlier approved call while rerunning a later continuation", async () => {
    await expect(
      rerunLaterOrder("change-a-and-move-its-decision-last"),
    ).rejects.toThrow(/preserve the stored tool-call for call-a/);
    expect(executed).toEqual(["a", "x"]);
  });

  test("an earlier decision cloned last does not run its call again", async () => {
    await rerunLaterOrder("clone-a-decision-last");

    expect(executed).toEqual(["a", "x"]);
  });

  test("rejects keeping a decision whose request was dropped", async () => {
    await expect(rerunLaterOrder("drop-request-a")).rejects.toThrow(
      /removed request for approval a/,
    );
    expect(executed).toEqual(["a", "x"]);
  });

  test.each<[ContextMode, Earlier, boolean, RegExp]>([
    ["flip-decision", "denied", false, /preserve the stored .* approval a/],
    ["remove-decision", "approved", false, /removed decision for approval a/],
    ["fabricate-approval-for-a", "pending", false, /cannot add approval/],
    [
      "fabricate-provider-approval-for-a",
      "pending",
      true,
      /cannot add approval/,
    ],
    ["fabricate-approval-for-y", "approved", false, /cannot add approval/],
    [
      "smuggle-approval-for-a-in-user",
      "denied",
      false,
      /tool-approval-response in a user message/,
    ],
    [
      "smuggle-approval-for-a-in-user",
      "pending",
      false,
      /tool-approval-response in a user message/,
    ],
    [
      "smuggle-request-in-user",
      "approved",
      false,
      /tool-approval-request in a user message/,
    ],
  ])(
    "rejects a context handler that alters a decision across orders: %s (earlier %s)",
    async (contextMode, earlier, providerExecuted, error) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const s = await scenario({ ids: ["a"], providerExecuted });
      await laterOrder(s, earlier, ["x", "y"]);
      const before = [...executed];

      await expect(
        s.continue(await s.approve("x"), contextMode),
      ).rejects.toThrow(error);
      expect(executed).toEqual(before);
    },
  );

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

  // A context handler may reorder, wrap, or annotate the stored record, but it
  // cannot change what was decided or executed. Shapes: "pending" has `a`
  // approved but not run; "completed" has `a` run and `b` approved; "with
  // another request" has `a` approved and a second request `c` at the order.
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

  test.each<[ContextMode, Shape, RegExp]>([
    ["change-input", "pending", /call-a/],
    ["flip-decision", "pending", /approval a/],
    ["flip-provider-executed", "pending", /approval a/],
    [
      "sign-request",
      "pending",
      /preserve the stored tool-approval-request for approval a/,
    ],
    [
      "mark-request-automatic",
      "pending",
      /preserve the stored tool-approval-request for approval a/,
    ],
    ["fabricate-result", "pending", /cannot add results/],
    ["fabricate-approval", "with-another-request", /cannot add approval/],
    [
      "fabricate-approval-for-another-request",
      "with-another-request",
      /cannot add approval/,
    ],
    [
      "clone-with-changed-first-copy",
      "completed",
      /preserve the stored tool-call for call-a/,
    ],
    ["remove-result", "completed", /removed result for call-a/],
  ])(
    "rejects a context handler that alters the record: %s (%s)",
    async (contextMode, shape, error) => {
      const s = await scenario();
      const messageId = await shaped(s, shape);
      const before = [...executed];

      await expect(s.continue(messageId, contextMode)).rejects.toThrow(error);
      expect(executed).toEqual(before);
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
    "rejects a handler that edits call-%s's input in place",
    async (id) => {
      const s = await scenario({ ids: ["a"] });
      await laterOrder(s, "approved");

      await expect(
        s.continue(
          await s.approve("x"),
          id === "a" ? "mutate-a-in-place" : "mutate-x-in-place",
        ),
      ).rejects.toThrow(`preserve the stored tool-call for call-${id}`);
      expect(executed).toEqual(["a"]);
    },
  );

  test("allows a context handler to add call provider options", async () => {
    const s = await scenario({ ids: ["a"] });

    await s.continue(await s.approve("a"), "add-call-provider-options");

    expect(executed).toEqual(["a"]);
    expect(partsFor("a")).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        providerOptions: { test: { trace: "allowed" } },
      }),
    );
  });

  test("message provider options a handler applies survive result relocation", async () => {
    const s = await scenario();
    await s.completeA();

    await s.continue(
      await s.approve("b"),
      "wrap-with-message-provider-options",
    );

    expect(executed).toEqual(["a", "b"]);
    for (const message of lastModelPrompt()) {
      expect(message.providerOptions).toEqual({ test: { cache: "all" } });
    }
  });

  // A handler that targets one message (cache control on the last message,
  // say) must keep working when the pair is synthesized from several.
  test.each<[ContextMode, boolean, "assistant" | "tool", string]>([
    ["split-calls-with-message-provider-options", false, "assistant", "slot-1"],
    ["split-responses-with-message-provider-options", true, "tool", "slot-1"],
    ["cache-last-message", true, "tool", "last"],
  ])(
    "the synthesized pair takes the last absorbed message's provider options: %s",
    async (contextMode, providerExecuted, role, cache) => {
      const s = await scenario({ providerExecuted });
      const messageId =
        contextMode === "cache-last-message"
          ? (await s.approve("a"), await s.approve("b"))
          : await s.approve("a", "b");

      await s.continue(messageId, contextMode);

      const final = lastModelPrompt()
        .filter((message) => message.role === role)
        .at(-1);
      expect(final?.providerOptions).toEqual({ test: { cache } });
      expect(partsFor("a")).not.toEqual([]);
      expect(partsFor("b")).not.toEqual([]);
    },
  );

  test("an unrelated generation still auto-denies unresolved approvals", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await scenario();
    await s.approve("a");

    await s.continue(await s.prompt("Start unrelated work"));

    expect(executed).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Auto-denying unresolved tool approval b"),
    );
  });
});
