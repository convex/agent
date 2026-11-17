// Layer 1 spec, through generateText and streamText. The rule under test:
// what any writer puts in shared messages may refuse a turn action, never
// permit one. The component's own fences are in src/component/turns.test.ts.
import { afterEach, describe, expect, test, vi } from "vitest";
import { simulateReadableStream, stepCountIs } from "ai";
import { Agent } from "../index.js";
import { components } from "./setup.test.js";
import { mockModel } from "./mockModel.js";
import {
  LEASE,
  REFUSALS,
  agent,
  attempt,
  dying,
  functionName,
  hold,
  initConvexTest,
  isStepSave,
  outcome,
  model,
  parts,
  queue,
  reset,
  rows,
  streamAt,
  tick,
  until,
  world,
  type Outcome,
  type Queued,
  type Row,
} from "./turnProbeKit.test.utils.js";
import type { ActionCtx } from "./types.js";

afterEach(() => vi.useRealTimers());

const later = (ms = LEASE + 60_000) => vi.setSystemTime(Date.now() + ms);

// A model outside `world`, for plain generations next to the turn.
const bystander = mockModel({
  doGenerate: async () => ({
    content: [{ type: "text", text: "plain" }],
    finishReason: { unified: "stop", raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  }),
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "plain" },
        { type: "text-end", id: "t" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ],
    }),
  }),
});

const refused = (o: Outcome) => "refused" in o && REFUSALS.includes(o.refused);
const atOrder = (saved: Row[], order: number) =>
  saved.filter((m) => m.order === order);
const answers = (saved: Row[], order: number) =>
  atOrder(saved, order).filter(
    (m) =>
      m.status === "success" &&
      m.role === "assistant" &&
      parts([m], "text").some(
        (p) => (p as unknown as { text: string }).text === "All done",
      ),
  );

const flaky = (failures: number) => {
  let calls = 0;
  return new Agent(components.agent, {
    name: "flaky",
    tools: agent.options.tools,
    stopWhen: stepCountIs(6),
    languageModel: mockModel({
      doGenerate: async (options) => {
        if (++calls <= failures) throw new Error("provider down");
        return (await model().doGenerate(options)) as never;
      },
    }),
  });
};

/** Settles `p`, or reports it still running after `ms`. */
async function within<T>(p: Promise<T>, ms = 300) {
  return Promise.race([p, tick(ms).then(() => "still running" as const)]);
}

describe("layer 1: a second attempt is refused before the model call", () => {
  test("a double submit calls the model once", async () => {
    reset([{ text: "All done" }]);
    const t = initConvexTest();
    const r = await t.action(async (ctx) => {
      const q = await queue(ctx);
      const both = await Promise.all([
        outcome(attempt(ctx, q)),
        outcome(attempt(ctx, q)),
      ]);
      return { both, saved: await rows(ctx, q.threadId), q };
    });
    expect(world.modelCalls).toBe(1);
    expect(r.both.filter(refused)).toHaveLength(1);
    expect(
      answers(r.saved, r.saved.find((m) => m.id === r.q.key)!.order),
    ).toHaveLength(1);
  });

  test("a retry after the answer is refused without a model call", async () => {
    reset([{ text: "All done" }]);
    const t = initConvexTest();
    const r = await t.action(async (ctx) => {
      const q = await queue(ctx);
      const first = await outcome(attempt(ctx, q));
      const retry = await outcome(attempt(ctx, q, "stream"));
      return { first, retry };
    });
    expect(r.first).toMatchObject({ text: "All done" });
    expect(r.retry).toMatchObject({ refused: "TurnEnded" });
    expect(world.modelCalls).toBe(1);
  });

  test("a retry while an attempt holds the lease is refused before the model call", async () => {
    reset([{ calls: [{ tool: "pay" }] }]);
    const release = hold("pay");
    const t = initConvexTest();
    const r = await t.action(async (ctx) => {
      const q = await queue(ctx);
      const first = outcome(attempt(ctx, q));
      await until(() => world.runs.pay === 1, "pay to start");
      const calls = world.modelCalls;
      const second = await within(outcome(attempt(ctx, q)));
      const callsBySecond = world.modelCalls - calls;
      release();
      return { first: await first, second, callsBySecond };
    });
    expect(r.second).toMatchObject({ refused: "TurnBusy" });
    expect(r.callsBySecond).toBe(0);
    expect(r.first).toMatchObject({ text: "All done" });
    expect(world.runs.pay).toBe(1);
  });

  test("a generation into a pending message takes no prompt", async () => {
    reset([{ text: "All done" }]);
    const t = initConvexTest();
    const r = await t.action(async (ctx) =>
      outcome(attempt(ctx, await queue(ctx), "generate", { prompt: "again" })),
    );
    expect(r).toMatchObject({
      error: expect.stringMatching(/takes no prompt/),
    });
    expect(world.modelCalls).toBe(0);
  });

  test("a clean failure releases the turn: an immediate retry answers it", async () => {
    reset([{ text: "All done" }]);
    const t = initConvexTest();
    const a = flaky(1);
    const r = await t.action(async (ctx) => {
      const q = await queue(ctx);
      const failed = await outcome(attempt(ctx, q, "generate", {}, a));
      const retry = await outcome(attempt(ctx, q, "generate", {}, a));
      return { failed, retry, saved: await rows(ctx, q.threadId) };
    });
    expect(r.failed).toMatchObject({ error: expect.stringMatching(/down/) });
    expect(r.retry).toMatchObject({ text: "All done" });
    expect(r.saved.filter((m) => m.status !== "success")).toEqual([]);
  });

  test("a crashed attempt is taken over after its lease and continues from its saved steps", async () => {
    reset([{ calls: [{ tool: "note" }] }, { text: "All done" }]);
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = initConvexTest();
    const r = await t.action(async (ctx) => {
      const q = await queue(ctx);
      let saves = 0;
      // Dies on the last step's save: step 0 (note) is saved.
      const d = dying(
        ctx,
        (name) =>
          isStepSave(name) && (world.runs.note ?? 0) > 0 && ++saves === 2,
      );
      void attempt(d.ctx, q).catch(() => {});
      await until(() => d.dead, "the second step save");
      await tick(20);
      const calls = world.modelCalls;
      const early = await outcome(attempt(ctx, q));
      const callsByEarly = world.modelCalls - calls;
      later();
      const takeover = await outcome(attempt(ctx, q));
      return {
        early,
        callsByEarly,
        takeover,
        saved: await rows(ctx, q.threadId),
        q,
      };
    });
    expect(r.early).toMatchObject({ refused: "TurnBusy" });
    expect(r.callsByEarly).toBe(0);
    expect(r.takeover).toMatchObject({ text: "All done" });
    const order = r.saved.find((m) => m.id === r.q.key)!.order;
    expect(world.runs.note).toBe(1);
    expect(answers(r.saved, order)).toHaveLength(1);
    expect(
      atOrder(r.saved, order).filter((m) => m.status === "pending"),
    ).toEqual([]);
  });
});

type Writer = (
  ctx: ActionCtx,
  turn: { q: Queued; order: number; slot: Row },
) => Promise<unknown>;

// Every function outside the turn that can write at its order or to its slot,
// on #449 (97580c2d). The approval answers are the test after this table.
const writers: Record<string, Writer> = {
  "a user message saved at the turn's order": (ctx, { q }) =>
    agent.saveMessage(ctx, {
      threadId: q.threadId,
      promptMessageId: q.promptId,
      message: { role: "user", content: "also this" },
    }),
  // A design that took the last pending message as the slot broke here.
  "another pending message saved at the turn's order": (ctx, { q }) =>
    agent.saveMessage(ctx, {
      threadId: q.threadId,
      promptMessageId: q.promptId,
      message: { role: "assistant", content: [] },
      metadata: { status: "pending" },
    }),
  "a tool result saved at the turn's order": (ctx, { q }) =>
    agent.saveMessage(ctx, {
      threadId: q.threadId,
      promptMessageId: q.promptId,
      message: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "pay-1",
            toolName: "pay",
            output: { type: "text", value: "paid" },
          },
        ],
      },
    }),
  "a prompt saved at the next order": (ctx, { q }) =>
    agent.saveMessage(ctx, { threadId: q.threadId, prompt: "newer" }),
  "a plain generation from a newer prompt": async (ctx, { q }) => {
    const { messageId } = await agent.saveMessage(ctx, {
      threadId: q.threadId,
      prompt: "newer",
    });
    return agent.generateText(
      ctx,
      { threadId: q.threadId },
      { promptMessageId: messageId, model: bystander },
    );
  },
  "a plain regeneration from the turn's prompt": (ctx, { q }) =>
    agent.generateText(
      ctx,
      { threadId: q.threadId },
      { promptMessageId: q.promptId, model: bystander },
    ),
  "a plain streamed regeneration from the turn's prompt": async (
    ctx,
    { q },
  ) => {
    const s = await agent.streamText(
      ctx,
      { threadId: q.threadId },
      { promptMessageId: q.promptId, model: bystander },
      { saveStreamDeltas: true },
    );
    await s.consumeStream();
  },
  "the slot filled by a plain save": (ctx, { q, slot }) =>
    ctx.runMutation(components.agent.messages.addMessages, {
      threadId: q.threadId,
      pendingMessageId: slot.id as never,
      messages: [{ message: { role: "assistant", content: "filled" } }],
    }),
  "the slot failed by finalizeMessage": (ctx, { slot }) =>
    ctx.runMutation(components.agent.messages.finalizeMessage, {
      messageId: slot.id as never,
      result: { status: "failed", error: "app" },
    }),
  "the slot finalized as success": (ctx, { slot }) =>
    ctx.runMutation(components.agent.messages.finalizeMessage, {
      messageId: slot.id as never,
      result: { status: "success" },
    }),
  "the slot edited by updateMessage": (ctx, { slot }) =>
    ctx.runMutation(components.agent.messages.updateMessage, {
      messageId: slot.id as never,
      patch: {
        status: "success",
        message: { role: "assistant", content: "edited" },
      },
    }),
  "the slot deleted": (ctx, { slot }) =>
    ctx.runMutation(components.agent.messages.deleteByIds, {
      messageIds: [slot.id as never],
    }),
  // Cloud round 1: deleting the prompt also aborts the streams at its order.
  "the turn's prompt deleted": (ctx, { q }) =>
    ctx.runMutation(components.agent.messages.deleteByIds, {
      messageIds: [q.promptId as never],
    }),
  "the turn's order deleted": (ctx, { q, order }) =>
    ctx.runMutation(components.agent.messages.deleteByOrder, {
      threadId: q.threadId as never,
      startOrder: order,
      endOrder: order + 1,
    }),
  "an embedding patched onto the slot": (ctx, { slot }) =>
    ctx.runMutation(components.agent.vector.index.insertBatch, {
      vectorDimension: 128,
      vectors: [
        {
          messageId: slot.id as never,
          model: "m",
          table: "messages",
          vector: Array.from({ length: 128 }, () => 0.1),
        },
      ],
    }),
  "streams at the turn's order aborted": (ctx, { q, order }) =>
    ctx.runMutation(components.agent.streams.abortByOrder, {
      threadId: q.threadId as never,
      order,
      reason: "app",
    }),
  "a thread cloned into the turn's order": async (ctx, { q, order }) => {
    const { threadId: source } = await agent.createThread(ctx, {});
    await agent.saveMessages(ctx, {
      threadId: source,
      messages: [
        { role: "user", content: "copied" },
        { role: "assistant", content: "copied answer" },
      ],
    });
    return ctx.runAction(components.agent.messages.cloneThread, {
      sourceThreadId: source as never,
      targetThreadId: q.threadId as never,
      insertAtOrder: order,
    });
  },
};

describe("layer 1: no plain writer permits a turn action", () => {
  // "deltas" streams with the stream row in place while the tool runs, so
  // the writers that abort streams reach the attempt (cloud round 1).
  test.each(
    (["generate", "deltas"] as const).flatMap((mode) =>
      Object.keys(writers).map((name) => [mode, name] as const),
    ),
  )(
    "%s, %s: retries stay refused, the model and the tool run once",
    async (mode, name) => {
      // Step 0's save inserts the slot the writer targets, so the slot is
      // not the key.
      reset([
        { calls: [{ tool: "note" }] },
        { calls: [{ tool: "pay" }] },
        { text: "All done" },
      ]);
      const release = hold("pay");
      const t = initConvexTest();
      const r = await t.action(async (ctx) => {
        const q = await queue(ctx);
        const first = outcome(attempt(ctx, q, mode));
        await until(() => world.runs.pay === 1, "pay to start");
        const order = (await rows(ctx, q.threadId)).find(
          (m) => m.id === q.key,
        )!.order;
        if (mode === "deltas") await streamAt(ctx, q.threadId, order);
        const slot = (await rows(ctx, q.threadId))
          .filter((m) => m.order === order && m.status === "pending")
          .at(-1)!;
        const wrote = await writers[name](ctx, { q, order, slot }).then(
          () => "ok",
          (e: Error) => `threw: ${e.message.slice(0, 80)}`,
        );
        const calls = world.modelCalls;
        const during = await within(outcome(attempt(ctx, q, mode)));
        const callsDuring = world.modelCalls - calls;
        release();
        const settled = await first;
        await tick(20);
        const callsAfter = world.modelCalls;
        const after = await outcome(attempt(ctx, q, mode));
        return {
          wrote,
          slotIsKey: slot.id === q.key,
          during,
          callsDuring,
          settled,
          after,
          callsByAfter: world.modelCalls - callsAfter,
        };
      });
      expect(r.slotIsKey).toBe(false);
      // Busy (the turn row's lease) or ended (the turn noticed its slot is
      // gone): either refuses. A plain error is not a turn refusal.
      expect(["TurnBusy", "TurnEnded"]).toContain(
        (r.during as { refused?: string }).refused,
      );
      expect(r.callsDuring).toBe(0);
      expect({ after: r.after, settled: r.settled }).toMatchObject({
        after: { refused: expect.stringMatching(/^Turn(Busy|Ended)$/) },
      });
      expect(r.callsByAfter).toBe(0);
      expect(world.runs.pay).toBe(1);
    },
    20_000,
  );

  // The independent diagnosis's counterexample: the answer is a plain write.
  test("an answer saved while an approved tool runs leaves the turn busy", async () => {
    reset([
      { calls: [{ tool: "pay" }, { tool: "confirm", input: { q: "ok?" } }] },
    ]);
    world.needsApproval = true;
    const t = initConvexTest();
    const r = await t.action(async (ctx) => {
      const q = await queue(ctx);
      const asked = await outcome(attempt(ctx, q));
      const requests = parts(
        await rows(ctx, q.threadId),
        "tool-approval-request",
      ) as unknown as { approvalId: string }[];
      for (const request of requests) {
        await agent.approveToolCall(ctx as never, {
          threadId: q.threadId,
          approvalId: request.approvalId,
        });
      }
      const release = hold("pay");
      const second = outcome(attempt(ctx, q));
      await until(() => (world.runs.pay ?? 0) > 0, "pay to start");
      await agent.saveMessage(ctx, {
        threadId: q.threadId,
        promptMessageId: q.promptId,
        message: {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "confirm-0",
              toolName: "confirm",
              output: { type: "text", value: "yes" },
            },
          ],
        },
      });
      const calls = world.modelCalls;
      const third = await within(outcome(attempt(ctx, q)));
      const callsByThird = world.modelCalls - calls;
      release();
      return { asked, second: await second, third, callsByThird };
    });
    expect(r.third).toMatchObject({ refused: "TurnBusy" });
    expect(r.callsByThird).toBe(0);
    expect(world.runs.pay).toBe(1);
  }, 20_000);
});

describe("layer 1: cloud failures and review findings", () => {
  // Codex round 1 P2 #1: a pending message first at its order had no anchor,
  // so its context took in newer orders and its saves landed at the latest.
  test("a pending message first at its order: its context and its saves stay at its order", async () => {
    reset([{ text: "unused" }, { calls: [{ tool: "note" }] }]);
    const t = initConvexTest();
    const r = await t.action(async (ctx) => {
      const { threadId } = await agent.createThread(ctx, {});
      await agent.saveMessages(ctx, {
        threadId,
        messages: [
          { role: "user", content: "earlier" },
          { role: "assistant", content: "answer" },
        ],
      });
      const { messages } = await ctx.runMutation(
        components.agent.messages.addMessages,
        {
          threadId,
          order: "next",
          messages: [
            {
              message: { role: "assistant", content: [] },
              status: "pending",
            },
          ],
        },
      );
      const key = messages[0];
      const { messageId: newer } = await agent.saveMessage(ctx, {
        threadId,
        prompt: "newer",
      });
      const result = await outcome(
        attempt(ctx, { threadId, promptId: "", key: key._id }),
      );
      return {
        result,
        order: key.order,
        newer,
        saved: await rows(ctx, threadId),
      };
    });
    expect(r.result).toMatchObject({ text: "All done" });
    expect(JSON.stringify(world.prompts)).not.toMatch(/newer/);
    const mine = r.saved.filter((m) => m.id !== r.newer && m.order >= r.order);
    expect(mine.map((m) => m.order)).toEqual(mine.map(() => r.order));
    expect(world.runs.note).toBe(1);
  });

  // agent.start hands the AI SDK call to the app, so nothing tracks its tool
  // starts or ends its attempt.
  test("agent.start refuses a pendingMessageId, even named as generateText", async () => {
    reset([{ text: "All done" }]);
    const t = initConvexTest();
    const r = await t.action(async (ctx) => {
      const q = await queue(ctx);
      const started = await outcome(
        agent
          .start(
            ctx,
            { pendingMessageId: q.key } as never,
            { threadId: q.threadId },
            "generateText",
          )
          .then(() => ({ text: "started" })),
      );
      const retry = await outcome(attempt(ctx, q));
      return { started, retry };
    });
    expect(r.started).toMatchObject({
      error: expect.stringMatching(/Only generateText and streamText/),
    });
    expect(r.retry).toMatchObject({ text: "All done" });
  });

  // Codex round 1 P2 #2: a throw after the claim held the lease.
  test("a startup failure after the claim releases the turn at once", async () => {
    reset([{ text: "All done" }]);
    const t = initConvexTest();
    let failures = 1;
    const flakyContext = new Agent(components.agent, {
      ...agent.options,
      name: "flaky context",
      contextHandler: async (_ctx, { allMessages }) => {
        if (failures-- > 0) throw new Error("context down");
        return allMessages;
      },
    });
    const r = await t.action(async (ctx) => {
      const q = await queue(ctx);
      const failed = await outcome(
        attempt(ctx, q, "generate", {}, flakyContext),
      );
      const retry = await outcome(
        attempt(ctx, q, "generate", {}, flakyContext),
      );
      return { failed, retry };
    });
    expect(r.failed).toMatchObject({
      error: expect.stringMatching(/context down/),
    });
    expect(r.retry).toMatchObject({ text: "All done" });
  });

  test("a generation with no model fails before the claim", async () => {
    reset([{ text: "All done" }]);
    const t = initConvexTest();
    const modelless = new Agent(components.agent, {
      ...agent.options,
      name: "modelless",
      languageModel: undefined,
    } as never);
    const r = await t.action(async (ctx) => {
      const q = await queue(ctx);
      const failed = await outcome(attempt(ctx, q, "generate", {}, modelless));
      const retry = await outcome(
        attempt(ctx, q, "generate", { model: model() }, modelless),
      );
      return { failed, retry };
    });
    expect(r.failed).toMatchObject({
      error: expect.stringMatching(/model is required/),
    });
    expect(r.retry).toMatchObject({ text: "All done" });
  });

  test("a step save that fails after its tool started holds the lease", async () => {
    reset([{ calls: [{ tool: "pay" }] }, { text: "All done" }]);
    const t = initConvexTest();
    const r = await t.action(async (ctx) => {
      const q = await queue(ctx);
      let saves = 0;
      const lossy = {
        ...ctx,
        runMutation: ((ref: never, args: never) =>
          isStepSave(functionName(ref)) && ++saves === 1
            ? Promise.reject(new Error("save lost"))
            : ctx.runMutation(ref, args)) as ActionCtx["runMutation"],
      } as ActionCtx;
      const first = await outcome(attempt(lossy, q));
      const calls = world.modelCalls;
      const retry = await within(outcome(attempt(ctx, q)));
      return { first, retry, callsByRetry: world.modelCalls - calls };
    });
    expect(r.first).toMatchObject({ error: expect.stringMatching(/lost/) });
    expect(r.retry).toMatchObject({ refused: "TurnBusy" });
    expect(r.callsByRetry).toBe(0);
    expect(world.runs.pay).toBe(1);
  });

  // Round 2 Codex P2 #1: the takeover's stream cleanup ran outside every
  // catch, so its failure held the new lease.
  test("a takeover whose stream cleanup fails releases the turn at once", async () => {
    reset([{ calls: [{ tool: "note" }] }, { text: "All done" }]);
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = initConvexTest();
    const r = await t.action(async (ctx) => {
      const q = await queue(ctx);
      let saves = 0;
      const d = dying(
        ctx,
        (name) =>
          isStepSave(name) && (world.runs.note ?? 0) > 0 && ++saves === 2,
      );
      void attempt(d.ctx, q).catch(() => {});
      await until(() => d.dead, "the second step save");
      await tick(20);
      later();
      let aborts = 0;
      const flaky = {
        ...ctx,
        runMutation: ((ref: never, args: never) =>
          functionName(ref) === "streams/abortByOrder" && ++aborts === 1
            ? Promise.reject(new Error("cleanup down"))
            : ctx.runMutation(ref, args)) as ActionCtx["runMutation"],
      } as ActionCtx;
      const failed = await outcome(attempt(flaky, q));
      const retry = await outcome(attempt(flaky, q));
      return { failed, retry };
    });
    expect(r.failed).toMatchObject({
      error: expect.stringMatching(/cleanup down/),
    });
    expect(r.retry).toMatchObject({ text: "All done" });
    expect(world.runs.note).toBe(1);
  });

  test("an invalid chunking option releases the turn at once", async () => {
    reset([{ text: "All done" }]);
    const t = initConvexTest();
    const r = await t.action(async (ctx) => {
      const q = await queue(ctx);
      const run = (chunking: unknown) =>
        outcome(
          agent
            .streamText(
              ctx,
              { threadId: q.threadId },
              { pendingMessageId: q.key },
              { saveStreamDeltas: { chunking: chunking as "word" } },
            )
            .then(async (result) => {
              await result.consumeStream();
              return { text: await result.text };
            }),
        );
      return { failed: await run("bogus"), retry: await run("word") };
    });
    expect(r.failed).toMatchObject({
      error: expect.stringMatching(/Chunking must be/),
    });
    expect(r.retry).toMatchObject({ text: "All done" });
  });

  test("a synchronous throw from the AI SDK's streamText releases the turn at once", async () => {
    reset([{ text: "All done" }]);
    const t = initConvexTest();
    const r = await t.action(async (ctx) => {
      const q = await queue(ctx);
      const failed = await outcome(
        attempt(ctx, q, "stream", { maxRetries: -1 }),
      );
      const retry = await outcome(attempt(ctx, q, "stream"));
      return { failed, retry };
    });
    expect(r.failed).toMatchObject({
      error: expect.stringMatching(/maxRetries/),
    });
    expect(r.retry).toMatchObject({ text: "All done" });
  });

  // Independent review of the round 2 design: a release after a tool started
  // lets a retry run it again, whatever failed the attempt.
  test("a streamed step that errors after its tool started holds the lease", async () => {
    reset([{ calls: [{ tool: "pay" }] }]);
    world.streamError = true;
    const t = initConvexTest();
    const r = await t.action(async (ctx) => {
      const q = await queue(ctx);
      const first = await outcome(attempt(ctx, q, "deltas"));
      world.streamError = false;
      const calls = world.modelCalls;
      const retry = await within(outcome(attempt(ctx, q, "deltas")));
      return { first, retry, callsByRetry: world.modelCalls - calls };
    });
    expect(r.first).not.toMatchObject({ text: "All done" });
    expect(r.retry).toMatchObject({ refused: "TurnBusy" });
    expect(r.callsByRetry).toBe(0);
    expect(world.runs.pay).toBe(1);
  });
});
