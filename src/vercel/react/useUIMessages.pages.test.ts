// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { makeFunctionReference } from "convex/server";
import { convexToJson, type Value } from "convex/values";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { components, initConvexTest } from "../client/setup.test.js";
import { syncStreams } from "../client/streaming.js";
import { listMessages } from "../../client/messages.js";
import { createThread } from "../../client/threads.js";
import { toUIMessages, type UIMessage } from "../UIMessages.js";
import { useThreadMessages } from "./useThreadMessages.js";
import { useUIMessages } from "./useUIMessages.js";

// A stand-in for the Convex client backed by the real component: every
// subscription the hooks open is answered by running the app query against
// convex-test, and `sync` is one round trip that re-runs them all. A result
// keeps its identity until its data changes, and every page usePaginatedQuery
// asks for is recorded under its own page key.
const client = {
  t: undefined as unknown as ReturnType<typeof initConvexTest>,
  subscriptions: new Map<string, { name: string; args: any }>(),
  results: new Map<string, { json: string; value: unknown }>(),
  pages: new Map<string, any>(),
};

function subscribe(query: unknown, args: any) {
  const name = (query as Record<symbol, string>)[Symbol.for("functionName")];
  const key = `${name}|${JSON.stringify(convexToJson(args as Value))}`;
  client.subscriptions.set(key, { name, args });
  return client.results.get(key)?.value;
}

vi.mock("convex/react", () => ({
  useConvex: () => ({ logger: console }),
  useQuery: (query: unknown, args: any) =>
    args === "skip" ? undefined : subscribe(query, args),
  useQueries: (queries: Record<string, { query: unknown; args: any }>) => {
    const results = Object.fromEntries(
      Object.entries(queries).map(([pageKey, { query, args }]) => {
        client.pages.set(
          `${pageKey}|${JSON.stringify(convexToJson(args as Value))}`,
          args,
        );
        return [pageKey, subscribe(query, args)];
      }),
    );
    const previous = lastQueriesResults.get(queries);
    if (
      previous &&
      Object.keys(results).length === Object.keys(previous).length &&
      Object.entries(results).every(([key, value]) => previous[key] === value)
    ) {
      return previous;
    }
    lastQueriesResults.set(queries, results);
    return results;
  },
}));

// Like the Convex client, useQueries hands back the same object until one of
// its results changes.
const lastQueriesResults = new WeakMap<object, Record<string, unknown>>();

// The app queries the hooks are pointed at: MessageDoc pages for
// useThreadMessages, and UIMessage pages, converted as listUIMessages does,
// for useUIMessages.
const queries = {
  rows: makeFunctionReference<"query">("chat:listMessages"),
  ui: makeFunctionReference<"query">("chat:listUIMessages"),
  uiWithoutTools: makeFunctionReference<"query">(
    "chat:listUIMessagesWithoutTools",
  ),
  uiSuccessOnly: makeFunctionReference<"query">(
    "chat:listUIMessagesSuccessOnly",
  ),
};
type Shape = keyof typeof queries;

function runQuery({ name, args }: { name: string; args: any }) {
  return client.t.run(async (ctx) => {
    const listArgs = {
      threadId: args.threadId,
      paginationOpts: args.paginationOpts,
    };
    const paginated = await listMessages(ctx, components.agent, {
      ...listArgs,
      excludeToolMessages: name.includes("WithoutTools"),
      statuses: name.includes("SuccessOnly") ? ["success"] : undefined,
    });
    const streams = await syncStreams(ctx, components.agent, args);
    return name.includes("UIMessages")
      ? { ...paginated, page: toUIMessages(paginated.page), streams }
      : { ...paginated, streams };
  });
}

async function sync(rerender: () => void) {
  // Results can open new subscriptions, so repeat until the set settles.
  for (let size = -1; size !== client.subscriptions.size; ) {
    size = client.subscriptions.size;
    for (const [key, request] of [...client.subscriptions]) {
      const value = await runQuery(request);
      const json = JSON.stringify(convexToJson(value as Value));
      if (client.results.get(key)?.json !== json) {
        client.results.set(key, { json, value });
      }
    }
    act(rerender);
  }
  // Let the streaming hooks finish converting what they received.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

// Pages fetched for new rows, as opposed to re-reads that pin or split a page
// already loaded.
function pagesLoaded() {
  return [...client.pages.values()].filter(
    (args) =>
      !args.paginationOpts.endCursor && args.paginationOpts.numItems > 0,
  ).length;
}

let threadId: string;

beforeEach(async () => {
  client.t = initConvexTest();
  client.subscriptions.clear();
  client.results.clear();
  client.pages.clear();
  threadId = await client.t.run((ctx) =>
    createThread(ctx, components.agent, { userId: "u" }),
  );
});

const addMessages = (args: {
  messages: unknown[];
  promptMessageId?: string;
  pendingMessageId?: string;
  finishStreamId?: string;
}) =>
  client.t.run((ctx) =>
    ctx.runMutation(components.agent.messages.addMessages, {
      threadId,
      ...(args as { messages: [] }),
    }),
  );

async function createStream(order: number, stepOrder: number) {
  const streamId = await client.t.run((ctx) =>
    ctx.runMutation(components.agent.streams.create, {
      threadId,
      order,
      stepOrder,
      format: "UIMessageChunk",
    }),
  );
  let cursor = 0;
  return {
    streamId,
    write: (parts: unknown[]) =>
      client.t.run((ctx) =>
        ctx.runMutation(components.agent.streams.addDelta, {
          streamId,
          start: cursor,
          end: ++cursor,
          parts,
        }),
      ),
  };
}

const toolCallFor = (toolCallId: string) => ({
  role: "assistant",
  content: [
    { type: "text", text: "checking" },
    {
      type: "tool-call",
      toolCallId,
      toolName: "weather",
      input: { city: "NYC" },
    },
  ],
});
const toolResultFor = (toolCallId: string) => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId,
      toolName: "weather",
      output: { type: "text", value: "72F" },
    },
  ],
});
const toolCall = toolCallFor("c1");
const toolResult = toolResultFor("c1");

async function seedEarlierExchange() {
  await addMessages({
    messages: [
      { message: { role: "user", content: "hi" } },
      { message: { role: "assistant", content: "hello" } },
    ],
  });
}

async function seedToolLoop() {
  return addMessages({
    messages: [
      { message: { role: "user", content: "what is the weather" } },
      { message: toolCall },
      { message: toolResult },
      { message: { role: "assistant", content: "It is 72F" } },
    ],
  });
}

const earlierExchange = [
  { role: "user", status: "success", parts: ["hi"] },
  { role: "assistant", status: "success", parts: ["hello"] },
];
const prompt = {
  role: "user",
  status: "success",
  parts: ["what is the weather"],
};
const streamingAnswer = {
  role: "assistant",
  status: "streaming",
  parts: ["checking", 'tool-weather {"city":"NYC"} -> 72F', "It is"],
};
const finishedAnswer = {
  role: "assistant",
  status: "success",
  parts: ["checking", 'tool-weather {"city":"NYC"} -> 72F', "It is 72F"],
};

// The rows and deltas streamText writes for a tool loop of `toolSteps`
// steps, stopped partway through the final text step.
async function startToolLoopGeneration(toolSteps = 1) {
  const started = await addMessages({
    messages: [
      { message: { role: "user", content: "what is the weather" } },
      { message: { role: "assistant", content: [] }, status: "pending" },
    ],
  });
  const promptDoc = started.messages[0];
  let pending = started.messages[1];
  const stream = await createStream(pending.order, pending.stepOrder);
  await stream.write([{ type: "start" }]);
  for (let i = 1; i <= toolSteps; i++) {
    await stream.write([
      { type: "start-step" },
      { type: "text-start", id: `t${i}` },
      { type: "text-delta", id: `t${i}`, delta: "checking" },
      { type: "text-end", id: `t${i}` },
      {
        type: "tool-input-available",
        toolCallId: `c${i}`,
        toolName: "weather",
        input: { city: "NYC" },
      },
      { type: "tool-output-available", toolCallId: `c${i}`, output: "72F" },
      { type: "finish-step" },
    ]);
    const step = await addMessages({
      promptMessageId: promptDoc._id,
      pendingMessageId: pending._id,
      messages: [
        { message: toolCallFor(`c${i}`) },
        { message: toolResultFor(`c${i}`) },
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
    });
    pending = step.messages.at(-1)!;
  }
  await stream.write([
    { type: "start-step" },
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: "It is" },
  ]);
  return {
    finish: async () => {
      await stream.write([
        { type: "text-delta", id: "answer", delta: " 72F" },
        { type: "text-end", id: "answer" },
        { type: "finish-step" },
        { type: "finish" },
      ]);
      await addMessages({
        promptMessageId: promptDoc._id,
        pendingMessageId: pending._id,
        finishStreamId: stream.streamId,
        messages: [{ message: { role: "assistant", content: "It is 72F" } }],
      });
    },
  };
}

function summarize(messages: UIMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    status: m.status,
    parts: m.parts.flatMap((p: any) =>
      p.type === "text"
        ? [p.text]
        : p.type.startsWith("tool-")
          ? [`${p.type} ${JSON.stringify(p.input)} -> ${p.output}`]
          : [],
    ),
  }));
}

function renderUIMessages(shape: Shape, initialNumItems: number) {
  const hook = renderHook(() =>
    useUIMessages(queries[shape] as never, { threadId } as never, {
      initialNumItems,
      stream: true as never,
    }),
  );
  return {
    sync: () => sync(hook.rerender),
    results: () => hook.result.current.results as UIMessage[],
    messages: () => summarize(hook.result.current.results as UIMessage[]),
    status: () => hook.result.current.status,
    loadMore: (n: number) => act(() => hook.result.current.loadMore(n)),
  };
}

describe("hook work across renders", () => {
  test("switching the query with the same args starts completion over", async () => {
    await seedEarlierExchange();
    await seedToolLoop();
    const hook = renderHook(
      ({ shape }: { shape: Shape }) =>
        useUIMessages(queries[shape] as never, { threadId } as never, {
          initialNumItems: 3,
        }),
      { initialProps: { shape: "uiWithoutTools" as Shape } },
    );
    const withoutTools = [
      ...earlierExchange,
      prompt,
      { role: "assistant", status: "success", parts: ["It is 72F"] },
    ];
    await sync(() => hook.rerender({ shape: "uiWithoutTools" }));
    expect(summarize(hook.result.current.results as UIMessage[])).toEqual(
      withoutTools,
    );
    await sync(() => hook.rerender({ shape: "ui" }));
    expect(summarize(hook.result.current.results as UIMessage[])).toEqual([
      prompt,
      finishedAnswer,
    ]);

    // The first query's pages are still loaded, so they come back at once.
    await sync(() => hook.rerender({ shape: "uiWithoutTools" }));
    expect(summarize(hook.result.current.results as UIMessage[])).toEqual(
      withoutTools,
    );
  });

  test("useThreadMessages keeps its results while nothing changed", async () => {
    await seedEarlierExchange();
    await seedToolLoop();
    const hook = renderHook(() =>
      useThreadMessages(queries.rows as never, { threadId } as never, {
        initialNumItems: 10,
        stream: true as never,
      }),
    );
    await sync(hook.rerender);
    const before = hook.result.current.results;
    act(() => hook.rerender());
    expect(hook.result.current.results).toBe(before);
  });
});

describe("useUIMessages when a page ends inside an order", () => {
  test("a finished tool loop split by the first page renders whole", async () => {
    await seedEarlierExchange();
    await seedToolLoop();
    const ui = renderUIMessages("ui", 2);
    await ui.sync();
    expect(ui.messages()).toEqual([prompt, finishedAnswer]);
    expect(ui.status()).toBe("CanLoadMore");
  });

  test("a streaming generation keeps its prompt, earlier steps and status", async () => {
    await seedEarlierExchange();
    const generation = await startToolLoopGeneration();
    const ui = renderUIMessages("ui", 2);
    await ui.sync();
    expect(ui.messages()).toEqual([prompt, streamingAnswer]);

    await generation.finish();
    await ui.sync();
    expect(ui.messages()).toEqual([prompt, finishedAnswer]);
  });

  test("a generation longer than many pages streams with its prompt", async () => {
    const started = await addMessages({
      messages: [
        { message: { role: "user", content: "what is the weather" } },
        ...Array.from({ length: 250 }, (_, i) => ({
          message: { role: "assistant", content: `step ${i}` },
        })),
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
    });
    // streamText keeps one stream for all steps of a call, starting at its
    // first step, so the saved steps here are steps of the streaming call.
    const stream = await createStream(started.messages[0].order, 1);
    await stream.write([
      { type: "start" },
      { type: "start-step" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "streaming" },
    ]);
    const ui = renderUIMessages("ui", 1);
    await ui.sync();
    expect(ui.messages()).toEqual([
      prompt,
      { role: "assistant", status: "streaming", parts: ["streaming"] },
    ]);
  }, 60_000);

  test("rows read past a deleted prompt are hidden until asked for", async () => {
    await seedEarlierExchange();
    const loop = await seedToolLoop();
    await client.t.run((ctx) =>
      ctx.runMutation(components.agent.messages.deleteByIds, {
        messageIds: [loop.messages[0]._id],
      }),
    );
    const ui = renderUIMessages("ui", 2);
    await ui.sync();
    expect(ui.messages()).toEqual([finishedAnswer]);
    expect(ui.status()).toBe("CanLoadMore");
    expect(pagesLoaded()).toBe(2);

    ui.loadMore(2);
    await ui.sync();
    expect(ui.messages()).toEqual([...earlierExchange, finishedAnswer]);
  });

  test("a first page that slides onto a new generation completes it", async () => {
    await seedEarlierExchange();
    const ui = renderUIMessages("ui", 2);
    await ui.sync();
    expect(ui.messages()).toEqual(earlierExchange);

    await startToolLoopGeneration();
    await ui.sync();
    expect(ui.messages()).toEqual([prompt, streamingAnswer]);
  });

  test("a pinned page split inside the streaming order renders the same", async () => {
    await seedEarlierExchange();
    const ui = renderUIMessages("ui", 2);
    await ui.sync();
    ui.loadMore(2);
    await ui.sync();
    expect(ui.status()).toBe("Exhausted");

    // The page grows to eight rows and usePaginatedQuery splits it after
    // the fourth, between the tool steps of the streaming order.
    await startToolLoopGeneration(2);
    await ui.sync();
    expect(ui.messages()).toEqual([
      ...earlierExchange,
      prompt,
      {
        ...streamingAnswer,
        parts: [
          "checking",
          'tool-weather {"city":"NYC"} -> 72F',
          "checking",
          'tool-weather {"city":"NYC"} -> 72F',
          "It is",
        ],
      },
    ]);
  });
});

// A generation retried in the same order while the first attempt's stream is
// still listed as streaming.
async function startRetriedGeneration() {
  const started = await addMessages({
    messages: [
      { message: { role: "user", content: "what is the weather" } },
      { message: { role: "assistant", content: [] }, status: "pending" },
    ],
  });
  const [promptDoc, firstPending] = started.messages;
  const first = await createStream(firstPending.order, firstPending.stepOrder);
  await first.write([
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "first try" },
  ]);
  const retried = await addMessages({
    promptMessageId: promptDoc._id,
    messages: [
      { message: { role: "assistant", content: [] }, status: "pending" },
    ],
  });
  const second = await createStream(
    retried.messages[0].order,
    retried.messages[0].stepOrder,
  );
  await second.write([
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "second try" },
  ]);
}

describe("useUIMessages streams resolved by order", () => {
  test("a success-only query keeps the live stream of a multi-step generation", async () => {
    await seedEarlierExchange();
    await startToolLoopGeneration();
    const ui = renderUIMessages("uiSuccessOnly", 10);
    await ui.sync();
    expect(ui.messages()).toEqual([
      ...earlierExchange,
      prompt,
      streamingAnswer,
    ]);
  });

  test("of two live streams for an order only the retry is shown", async () => {
    await startRetriedGeneration();
    const ui = renderUIMessages("ui", 10);
    await ui.sync();
    expect(ui.messages()).toEqual([
      prompt,
      { role: "assistant", status: "streaming", parts: ["second try"] },
    ]);
  });
});

describe("useUIMessages tool parts across pages", () => {
  test("a tool call between two texts keeps its place across pages", async () => {
    await seedEarlierExchange();
    await addMessages({
      messages: [
        { message: { role: "user", content: "what is the weather" } },
        {
          message: {
            ...toolCall,
            content: [...toolCall.content, { type: "text", text: "then" }],
          },
        },
        { message: toolResult },
        { message: { role: "assistant", content: "It is 72F" } },
      ],
    });
    const ui = renderUIMessages("ui", 2);
    await ui.sync();
    expect(ui.messages()).toEqual([
      prompt,
      {
        ...finishedAnswer,
        parts: [
          "checking",
          'tool-weather {"city":"NYC"} -> 72F',
          "then",
          "It is 72F",
        ],
      },
    ]);
  });
});

describe("useUIMessages over a filtered query", () => {
  test("completing a boundary order stops at the order the user asked for", async () => {
    for (let i = 0; i < 5; i++) {
      await seedToolLoop();
    }
    const ui = renderUIMessages("uiWithoutTools", 1);
    await ui.sync();
    expect(ui.messages()).toEqual([
      prompt,
      { role: "assistant", status: "success", parts: ["It is 72F"] },
    ]);
    expect(pagesLoaded()).toBe(2);

    // The rows read past the boundary are already loaded.
    ui.loadMore(1);
    await ui.sync();
    expect(ui.messages()).toEqual([
      prompt,
      { role: "assistant", status: "success", parts: ["It is 72F"] },
      prompt,
      { role: "assistant", status: "success", parts: ["It is 72F"] },
    ]);
    expect(pagesLoaded()).toBe(2);
  });
});

describe("useThreadMessages when the first page ends inside an order", () => {
  function renderThreadMessages(
    initialNumItems: number,
    shape: Shape = "rows",
  ) {
    const hook = renderHook(() =>
      useThreadMessages(queries[shape] as never, { threadId } as never, {
        initialNumItems,
        stream: true as never,
      }),
    );
    return {
      sync: () => sync(hook.rerender),
      rerender: () => act(() => hook.rerender()),
      rows: () =>
        hook.result.current.results.map(
          (m: any) =>
            `${m.order}/${m.stepOrder} ${m.status}${m.streaming ? " streaming" : ""}${m.text ? ` ${m.text}` : ""}`,
        ),
    };
  }

  test("switching threads never applies one thread's stream to another's rows", async () => {
    const threadB = threadId;
    await seedToolLoop();
    await startToolLoopGeneration();
    const threadA = await client.t.run((ctx) =>
      createThread(ctx, components.agent, { userId: "u" }),
    );
    threadId = threadA;
    await startToolLoopGeneration();

    threadId = threadB;
    const thread = renderThreadMessages(10);
    await thread.sync();
    threadId = threadA;
    await thread.sync();
    expect(thread.rows().at(-1)).toBe("0/3 pending streaming It is");

    // Thread B's own stream is listed but not yet converted on this render.
    threadId = threadB;
    thread.rerender();
    expect(thread.rows().filter((row) => row.startsWith("0/"))).toEqual([
      "0/0 success what is the weather",
      "0/1 success checking",
      "0/2 success",
      "0/3 success It is 72F",
    ]);
  });

  test("the page holds every row of the order", async () => {
    await seedEarlierExchange();
    await seedToolLoop();
    const thread = renderThreadMessages(2);
    await thread.sync();
    expect(thread.rows()).toEqual([
      "1/0 success what is the weather",
      "1/1 success checking",
      "1/2 success",
      "1/3 success It is 72F",
    ]);
  });
});
