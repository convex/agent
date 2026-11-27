import { describe, expect, expectTypeOf, test, vi } from "vitest";
import {
  APICallError,
  Experimental_DecisionRefusalError,
  type Experimental_DecisionQuestion,
} from "ai";
import { Experimental_DecisionMockModelV4 } from "ai/test";
import type {
  Experimental_DecisionModelV4Answer,
  Experimental_DecisionModelV4CallOptions,
  Experimental_DecisionModelV4Result,
} from "@ai-sdk/provider";
import {
  Agent,
  createThread,
  experimental_correctDecision,
  experimental_listDecisions,
  saveMessage,
  type DecideArgs,
  type DecideResult,
  type DecisionDoc,
  type DecisionQuestions,
  type UsageHandler,
} from "../index.js";
import { components, initConvexTest } from "./setup.test.js";
import { mockModel, type MockLanguageModel } from "./mockModel.js";
import type { ActionCtx } from "./types.js";

const questions = {
  intent: {
    type: "choice",
    instructions: "What does the user want?",
    criteria: { status: "a status update", compare: "a comparison" },
  },
  ambiguous: { type: "boolean", instructions: "Is the request ambiguous?" },
} as const;

type Calls = Experimental_DecisionModelV4CallOptions[];

// Picks each choice question's first option.
function decisionModel(
  calls: Calls = [],
  result: Partial<Experimental_DecisionModelV4Result> = {},
) {
  return new Experimental_DecisionMockModelV4({
    provider: "typesafe",
    modelId: "jev-1.14",
    supportedQuestionTypes: ["choice", "score", "box", "boolean"],
    doDecide: async (options) => {
      calls.push(options);
      const answers: Record<string, Experimental_DecisionModelV4Answer> = {};
      for (const [id, question] of Object.entries(options.questions)) {
        if (question.type === "score") {
          answers[id] = { type: "score", score: question.criteria.length - 1 };
          continue;
        }
        if (question.type === "box") {
          answers[id] = {
            type: "box",
            box: { top: 0, bottom: 1, left: 0, right: 1 },
          };
          continue;
        }
        if (question.type !== "choice") {
          answers[id] = { type: "boolean", probability: 0.12 };
          continue;
        }
        const [first, ...rest] = Object.keys(question.criteria);
        answers[id] = {
          type: "choice",
          choice: first,
          probabilities: Object.fromEntries([
            [first, 0.8],
            ...rest.map((key) => [key, 0.2 / rest.length]),
          ]),
        };
      }
      return {
        answers,
        usage: { inputTokens: 120 },
        providerMetadata: { convexGateway: { cost: 0.00012 } },
        warnings: [],
        response: { modelId: "typesafe/jev-1.14-20261014" },
        ...result,
      };
    },
  });
}

function makeAgent(config: Partial<ConstructorParameters<typeof Agent>[1]>) {
  return new Agent(components.agent, {
    name: "router",
    languageModel: mockModel({ content: [{ type: "text", text: "ok" }] }),
    experimental_decisionModel: decisionModel(),
    ...config,
  });
}

async function seedThread(ctx: ActionCtx, userId = "u1") {
  const threadId = await createThread(ctx, components.agent, { userId });
  await saveMessage(ctx, components.agent, {
    threadId,
    message: { role: "user", content: "how is the release going?" },
  });
  await saveMessage(ctx, components.agent, {
    threadId,
    message: { role: "assistant", content: "Which release?" },
  });
  const { messageId } = await saveMessage(ctx, components.agent, {
    threadId,
    message: { role: "user", content: "the 0.7 one, compare it to 0.6" },
  });
  return { threadId, promptMessageId: messageId };
}

const firstPage = { numItems: 10, cursor: null };

function list<const Q extends Record<string, Experimental_DecisionQuestion>>(
  ctx: ActionCtx,
  threadId: string,
  questions: Q,
) {
  return experimental_listDecisions(ctx, components.agent, {
    threadId,
    questions,
    paginationOpts: firstPage,
  });
}

function texts(messages: { role: string; content: unknown }[]) {
  return messages.map((m) => ({
    role: m.role,
    text:
      typeof m.content === "string"
        ? m.content
        : (m.content as { text?: string }[]).map((p) => p.text ?? "").join(""),
  }));
}

describe("experimental_decide reads the context generateText builds", () => {
  test("the state is the turn's prompt messages, then the caller's state", async () => {
    const calls: Calls = [];
    const languageModel = mockModel({
      content: [{ type: "text", text: "ok" }],
    }) as MockLanguageModel;
    const agent = makeAgent({
      languageModel,
      experimental_decisionModel: decisionModel(calls),
      contextHandler: async (_ctx, { allMessages }) => [
        { role: "user", content: "pinned: user is on the release page" },
        ...allMessages,
      ],
    });
    await initConvexTest().action(async (ctx) => {
      const { threadId, promptMessageId } = await seedThread(ctx);
      await agent.experimental_decide(
        ctx,
        { threadId },
        { questions, promptMessageId, state: { page: "release" } },
      );
      await agent.generateText(ctx, { threadId }, { promptMessageId });
    });
    const [context, callerState] = calls[0].state as unknown as [
      { type: "json"; value: { messages: [] } },
      unknown,
    ];
    expect(calls[0].state).toHaveLength(2);
    expect(callerState).toEqual({ type: "json", value: { page: "release" } });
    expect(texts(context.value.messages)).toEqual(
      texts(languageModel.doGenerateCalls[0].prompt),
    );
  });

  test("files in the context become state file parts after the messages", async () => {
    const calls: Calls = [];
    const agent = makeAgent({
      experimental_decisionModel: decisionModel(calls),
    });
    await initConvexTest().action(async (ctx) => {
      const threadId = await createThread(ctx, components.agent, {});
      await saveMessage(ctx, components.agent, {
        threadId,
        message: {
          role: "user",
          content: [
            { type: "text", text: "is this a release chart?" },
            {
              type: "file",
              data: new Uint8Array([137, 80, 78, 71]),
              mediaType: "image/png",
            },
          ],
        },
      });
      await agent.experimental_decide(ctx, { threadId }, { questions });
    });
    const [json, file] = calls[0].state as unknown as [
      { value: { messages: { content: unknown[] }[] } },
      unknown,
    ];
    expect(json.value.messages[0].content[1]).toEqual({
      type: "file",
      mediaType: "image/png",
      stateFile: 0,
    });
    expect(file).toMatchObject({ type: "file", mediaType: "image/png" });
  });
});

describe("a stored decision", () => {
  test("keeps what the model saw and answered, and leaves the thread's messages alone", async () => {
    const run = (decide: boolean) =>
      initConvexTest().action(async (ctx) => {
        const agent = makeAgent({});
        const { threadId, promptMessageId } = await seedThread(ctx);
        const decided = decide
          ? await agent.experimental_decide(
              ctx,
              { threadId },
              { questions, promptMessageId, state: { page: "release" } },
            )
          : undefined;
        await agent.generateText(ctx, { threadId }, { promptMessageId });
        const { page } = await ctx.runQuery(
          components.agent.messages.listMessagesByThreadId,
          { threadId, order: "asc" },
        );
        return {
          decisionId: decided?.decisionId,
          listed: (await list(ctx, threadId, questions)).page,
          contextIds: page.slice(0, 3).map((m) => m._id),
          messages: page.map((m) => [m.order, m.stepOrder, m.message?.role]),
        };
      });
    const without = await run(false);
    const withDecision = await run(true);
    expect(withDecision.messages).toEqual(without.messages);
    const [stored] = withDecision.listed;
    expect(stored._id).toBe(withDecision.decisionId);
    expect(stored.contextMessageIds).toEqual(withDecision.contextIds);
    expect(JSON.parse(stored.state!)).toEqual({ page: "release" });
    expect(stored.questions).toEqual(questions);
    expect(stored.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).toMatchObject({
      agentName: "router",
      order: 1,
      requestedModel: "jev-1.14",
      model: "typesafe/jev-1.14-20261014",
      provider: "typesafe",
      answers: {
        intent: {
          type: "choice",
          choice: "status",
          probabilities: { status: 0.8, compare: 0.2 },
        },
        ambiguous: { type: "boolean", probability: 0.12 },
      },
      corrections: {},
      usage: { promptTokens: 120, totalTokens: 120 },
      providerMetadata: { convexGateway: { cost: 0.00012 } },
    });
  });

  test("is not stored without a thread or with saveMessages none", async () => {
    const agent = makeAgent({});
    const out = await initConvexTest().action(async (ctx) => {
      const { threadId } = await seedThread(ctx);
      const none = await agent.experimental_decide(
        ctx,
        { threadId },
        { questions },
        { storageOptions: { saveMessages: "none" } },
      );
      const noThread = await agent.experimental_decide(
        ctx,
        {},
        { questions, state: "status?" },
      );
      return {
        ids: [none.decisionId ?? null, noThread.decisionId ?? null],
        stored: (await list(ctx, threadId, questions)).page.length,
      };
    });
    expect(out).toEqual({ ids: [null, null], stored: 0 });
  });

  test("a decision over a missing thread throws before the model is called", async () => {
    const calls: Calls = [];
    const agent = makeAgent({
      experimental_decisionModel: decisionModel(calls),
    });
    const errors = await initConvexTest().action(async (ctx) => {
      const { threadId } = await seedThread(ctx);
      await agent.deleteThreadSync(ctx, { threadId });
      const attempt = (threadOpts: { threadId: string; userId?: string }) =>
        agent.experimental_decide(ctx, threadOpts, { questions }).then(
          () => "decided",
          (e: Error) => e.message,
        );
      return [
        await attempt({ threadId }),
        await attempt({ threadId, userId: "u1" }),
      ];
    });
    expect(errors).toEqual(
      Array(2).fill(expect.stringMatching(/Thread .* not found/)),
    );
    expect(calls).toHaveLength(0);
  });

  test("question IDs, option keys and providerOptions keys are stored as given, however many and whatever their characters", async () => {
    const calls: Calls = [];
    const agent = makeAgent({
      experimental_decisionModel: decisionModel(calls),
    });
    const asked = {
      $release: { type: "boolean", instructions: "Is it the release?" },
      _meta: { type: "boolean", instructions: "Is it about this chat?" },
      team: {
        type: "choice",
        criteria: {
          _none: "no team",
          Café: "the cafe",
          ...Object.fromEntries(
            Array.from({ length: 1100 }, (_, i) => [`o${i}`, `option ${i}`]),
          ),
        },
      },
      level: {
        type: "score",
        criteria: Array.from({ length: 1026 }, (_, i) => `level ${i}`),
      },
    } satisfies Record<string, Experimental_DecisionQuestion>;
    const providerOptions = { typesafe: { $seed: 1, température: 1 } };
    // An action's return value is a Convex value, which these keys can't be.
    const json = await initConvexTest().action(async (ctx) => {
      const { threadId } = await seedThread(ctx);
      const decide = () =>
        agent.experimental_decide(
          ctx,
          { threadId },
          { questions: asked, providerOptions, cache: { ttlMs: 60_000 } },
        );
      const decided = await decide();
      const hit = await decide();
      await experimental_correctDecision(ctx, components.agent, {
        threadId,
        decisionId: decided.decisionId!,
        questions: asked,
        questionId: "team",
        answer: {
          type: "choice",
          choice: "Café",
          probabilities: Object.fromEntries(
            Object.keys(asked.team.criteria).map((key) => [
              key,
              key === "Café" ? 1 : 0,
            ]),
          ) as Record<keyof typeof asked.team.criteria, number>,
        },
      });
      const [stored] = (await list(ctx, threadId, asked)).page;
      return JSON.stringify({ decided, hit, stored });
    });
    const out: {
      decided: { decisionId: string; answers: unknown };
      hit: unknown;
      stored: DecisionDoc<typeof asked>;
    } = JSON.parse(json);
    expect(calls).toHaveLength(1);
    expect(out.hit).toMatchObject({
      cached: true,
      decisionId: out.decided.decisionId,
      answers: out.decided.answers,
    });
    expect(out.stored.questions).toEqual(asked);
    expect(out.stored.settings).toEqual({ providerOptions });
    expect(out.stored.answers).toEqual(out.decided.answers);
    expect(out.stored.corrections.team?.answer.choice).toBe("Café");
  });

  test("a decision too large to store with room for the model's output is refused before the model is called", async () => {
    const calls: Calls = [];
    const agent = makeAgent({
      experimental_decisionModel: decisionModel(calls),
    });
    const error = await initConvexTest().action(async (ctx) => {
      const { threadId } = await seedThread(ctx);
      return agent
        .experimental_decide(
          ctx,
          { threadId },
          { questions, state: "x".repeat(1_000_000) },
        )
        .then(
          () => "decided",
          (e: Error) => e.message,
        );
    });
    expect(error).toMatch(
      /over the \d+ bytes Convex's 1 MiB document limit leaves for them; the largest is state/,
    );
    expect(calls).toHaveLength(0);
  });

  test("a decision the model's output makes too large isn't stored, and its result is on the error", async () => {
    const seen: unknown[] = [];
    const agent = makeAgent({
      usageHandler: async (_ctx, { usage }) => {
        seen.push(usage.inputTokens);
      },
      experimental_decisionModel: decisionModel([], {
        providerMetadata: { typesafe: { trace: "y".repeat(200_000) } },
      }),
    });
    const out = await initConvexTest().action(async (ctx) => {
      const { threadId } = await seedThread(ctx);
      const error = await agent
        .experimental_decide(
          ctx,
          { threadId },
          { questions, state: "x".repeat(900_000) },
        )
        .then(
          () => undefined,
          (e: Error) => e,
        );
      const cause = error?.cause as { answers?: unknown } | undefined;
      return {
        message: error?.message,
        answers: cause?.answers ?? null,
        stored: (await list(ctx, threadId, questions)).page.length,
      };
    });
    expect(out.message).toMatch(
      /over Convex's 1 MiB document limit; the largest field is state/,
    );
    expect(out.answers).toMatchObject({ intent: { choice: "status" } });
    expect(out.stored).toBe(0);
    expect(seen).toEqual([120]);
  });

  test("an answer, or a correction, too large to store is refused, naming the largest field", async () => {
    const agent = makeAgent({});
    const choice = (n: number) =>
      ({
        type: "choice",
        criteria: Object.fromEntries(
          Array.from({ length: n }, (_, i) => [
            `option-${String(i).padStart(113, "0")}`,
            "",
          ]),
        ),
      }) as const;
    const fits = { team: choice(5_000) };
    const out = await initConvexTest().action(async (ctx) => {
      const { threadId } = await seedThread(ctx);
      const tooLarge = await agent
        .experimental_decide(
          ctx,
          { threadId },
          { questions: { team: choice(7_300) } },
        )
        .then(
          () => undefined,
          (e: Error) => e,
        );
      const { decisionId } = await agent.experimental_decide(
        ctx,
        { threadId },
        { questions: fits },
      );
      const keys = Object.keys(fits.team.criteria);
      const correction = await experimental_correctDecision(
        ctx,
        components.agent,
        {
          threadId,
          decisionId: decisionId!,
          questions: fits,
          questionId: "team",
          answer: {
            type: "choice",
            choice: keys[1],
            probabilities: Object.fromEntries(
              keys.map((key, i) => [key, i === 1 ? 1 : 0]),
            ),
          },
        },
      ).then(
        () => "corrected",
        (e: Error) => e.message,
      );
      const { page } = await experimental_listDecisions(ctx, components.agent, {
        threadId,
        paginationOpts: firstPage,
      });
      return {
        answer: tooLarge?.message,
        hasResult: !!(tooLarge?.cause as { answers?: unknown })?.answers,
        correction,
        stored: page.map((d) => Object.keys(d.corrections).length),
      };
    });
    expect(out.answer).toMatch(
      /over Convex's 1 MiB document limit; the largest field is answer/,
    );
    expect(out.hasResult).toBe(true);
    expect(out.correction).toMatch(
      /over Convex's 1 MiB document limit; the largest field is answer/,
    );
    expect(out.stored).toEqual([0]);
  });

  test("a listed page stops short of the read limit, however large its decisions, and the next continues it", async () => {
    const agent = makeAgent({});
    const out = await initConvexTest({ transactionLimits: true }).action(
      async (ctx) => {
        const { threadId } = await seedThread(ctx);
        for (let i = 0; i < 20; i++) {
          await agent.experimental_decide(
            ctx,
            { threadId },
            { questions, state: String(i).padEnd(900_000, "x") },
          );
        }
        const pages = async (asked?: typeof questions) => {
          const sizes: number[] = [];
          const ids = new Set<string>();
          let cursor: string | null = null;
          for (;;) {
            const result: {
              page: { _id: string }[];
              isDone: boolean;
              continueCursor: string;
            } = await experimental_listDecisions(ctx, components.agent, {
              threadId,
              questions: asked as typeof questions,
              paginationOpts: { numItems: 20, cursor },
            });
            sizes.push(result.page.length);
            for (const d of result.page) ids.add(d._id);
            if (result.isDone) return { sizes, listed: ids.size };
            cursor = result.continueCursor;
          }
        };
        return { all: await pages(), asked: await pages(questions) };
      },
    );
    for (const { sizes, listed } of [out.all, out.asked]) {
      expect(sizes.length).toBeGreaterThan(1);
      expect(sizes.reduce((a, b) => a + b)).toBe(20);
      expect(listed).toBe(20);
    }
  });

  test("is not stored once its thread is deleted during the call", async () => {
    const out = await initConvexTest().action(async (ctx) => {
      const { threadId } = await seedThread(ctx);
      const model = decisionModel();
      const agent = makeAgent({
        experimental_decisionModel: new Experimental_DecisionMockModelV4({
          doDecide: async (options) => {
            await agent.deleteThreadSync(ctx, { threadId });
            return model.doDecide(options);
          },
        }),
      });
      const error = await agent
        .experimental_decide(ctx, { threadId }, { questions })
        .then(
          () => "decided",
          (e: Error) => e.message,
        );
      const pages = await Promise.all([
        experimental_listDecisions(ctx, components.agent, {
          threadId,
          paginationOpts: firstPage,
        }),
        list(ctx, threadId, questions),
      ]);
      return { error, left: pages.map((p) => p.page.length) };
    });
    expect(out).toEqual({
      error: expect.stringMatching(/Thread .* not found/),
      left: [0, 0],
    });
  });

  test("is deleted with its thread, synchronously, asynchronously or with its user, however large", async () => {
    const t = initConvexTest({ transactionLimits: { bytesRead: 4 << 20 } });
    const agent = makeAgent({});
    const deletes = [
      (threadId: string) =>
        t.action((ctx) => agent.deleteThreadSync(ctx, { threadId })),
      async (threadId: string) => {
        vi.useFakeTimers();
        try {
          await t.action((ctx) =>
            ctx.runMutation(
              components.agent.threads.deleteAllForThreadIdAsync,
              {
                threadId,
              },
            ),
          );
          await t.finishAllScheduledFunctions(vi.runAllTimers);
        } finally {
          vi.useRealTimers();
        }
      },
      () =>
        t.action((ctx) =>
          ctx.runAction(components.agent.users.deleteAllForUserId, {
            userId: "u2",
          }),
        ),
    ];
    const left = [];
    for (const [i, remove] of deletes.entries()) {
      // More than one transaction can read, so deleting crosses pages.
      const threadId = await t.action(async (ctx) => {
        const { threadId } = await seedThread(ctx, `u${i}`);
        for (let j = 0; j < 12; j++) {
          await agent.experimental_decide(
            ctx,
            { threadId },
            { questions, state: "x".repeat(400_000) },
          );
        }
        return threadId;
      });
      await remove(threadId);
      left.push(
        await t.action(async (ctx) => {
          const pages = await Promise.all([
            experimental_listDecisions(ctx, components.agent, {
              threadId,
              paginationOpts: firstPage,
            }),
            // Pages over answer rows, so leftover answers would be listed.
            list(ctx, threadId, questions),
          ]);
          return pages.map((p) => p.page.length);
        }),
      );
    }
    expect(left).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });
});

describe("decision usage", () => {
  test("reaches the usageHandler, with input tokens alone as the total", async () => {
    const seen: Parameters<UsageHandler>[1][] = [];
    const agent = makeAgent({
      usageHandler: async (_ctx, args) => {
        seen.push(args);
      },
    });
    const promptMessageId = await initConvexTest().action(async (ctx) => {
      const { threadId, promptMessageId } = await seedThread(ctx);
      await agent.experimental_decide(
        ctx,
        { threadId },
        { questions, promptMessageId },
      );
      return promptMessageId;
    });
    expect(seen).toEqual([
      expect.objectContaining({
        userId: "u1",
        agentName: "router",
        model: "typesafe/jev-1.14-20261014",
        provider: "typesafe",
        promptMessageId,
        usage: expect.objectContaining({ inputTokens: 120, totalTokens: 120 }),
        providerMetadata: { convexGateway: { cost: 0.00012 } },
      }),
    ]);
  });

  test("errors reach the caller unchanged, and a refusal reports no usage until the AI SDK does (https://github.com/vercel/ai/issues/25546)", async () => {
    const seen: number[] = [];
    const usageHandler: UsageHandler = async (_ctx, { usage }) => {
      seen.push(usage.totalTokens!);
    };
    const refusal = decisionModel([], {
      answers: {
        intent: { type: "refusal" },
        ambiguous: { type: "boolean", probability: 0.5 },
      },
    });
    const refused = makeAgent({
      usageHandler,
      experimental_decisionModel: refusal,
    });
    const zdr = new APICallError({
      message:
        "Evaluation failed (404): No endpoints found matching your data policy (Zero data retention).",
      url: "https://ai-gateway.convex.dev/alpha/decisions",
      requestBodyValues: {},
      statusCode: 404,
      isRetryable: false,
    });
    const unavailable = makeAgent({
      usageHandler,
      experimental_decisionModel: new Experimental_DecisionMockModelV4({
        doDecide: async () => {
          throw zdr;
        },
      }),
    });
    const errorOf = (agent: Agent) =>
      initConvexTest()
        .action((ctx) =>
          agent.experimental_decide(ctx, {}, { questions, state: "x" }),
        )
        .catch((e: unknown) => e);
    expect(
      Experimental_DecisionRefusalError.isInstance(await errorOf(refused)),
    ).toBe(true);
    expect(await errorOf(unavailable)).toBe(zdr);
    expect(seen).toEqual([]);
  });
});

test("the cache reuses a decision in the same thread for the same model, state and question versions, within the TTL", async () => {
  const calls: Calls = [];
  const agent = makeAgent({ experimental_decisionModel: decisionModel(calls) });
  const cache = { ttlMs: 60_000 };
  const reworded = {
    ...questions,
    intent: { ...questions.intent, instructions: "What is being asked?" },
  } as const;
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const out = await initConvexTest().action(async (ctx) => {
      const { threadId } = await seedThread(ctx);
      const decide = async (
        args: Parameters<typeof agent.experimental_decide>[2],
      ) => {
        const { decisionId, cached, answers } = await agent.experimental_decide(
          ctx,
          { threadId },
          args,
        );
        return { decisionId, cached, intent: answers.intent };
      };
      const results = [
        await decide({ questions, cache }),
        await decide({ questions, cache }),
        await decide({ questions: { intent: questions.intent }, cache }),
        await decide({ questions, state: "changed", cache }),
        await decide({ questions: reworded, cache }),
        await decide({ questions }),
      ];
      vi.advanceTimersByTime(2 * cache.ttlMs);
      results.push(await decide({ questions, cache }));
      const other = await seedThread(ctx, "u2");
      results.push(
        await agent
          .experimental_decide(
            ctx,
            { threadId: other.threadId },
            { questions, cache },
          )
          .then(({ decisionId, cached, answers }) => ({
            decisionId,
            cached,
            intent: answers.intent,
          })),
      );
      const rows = (await list(ctx, threadId, questions)).page.reverse();
      return { results, ids: rows.map((r) => r._id) };
    });
    expect(calls).toHaveLength(6);
    const { results, ids } = out;
    expect(results.map((r) => r.cached)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(results[1]).toEqual({ ...results[0], cached: true });
    expect(results[2].decisionId).toBe(results[0].decisionId);
    expect(ids).toEqual([0, 3, 4, 5, 6].map((i) => results[i].decisionId));
  } finally {
    vi.useRealTimers();
  }
});

test("the TTL counts from when the model made the decision, not from cache hits", async () => {
  const calls: Calls = [];
  const agent = makeAgent({ experimental_decisionModel: decisionModel(calls) });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    await initConvexTest().action(async (ctx) => {
      const { threadId } = await seedThread(ctx);
      for (let i = 0; i < 3; i++) {
        await agent.experimental_decide(
          ctx,
          { threadId },
          { questions, cache: { ttlMs: 1000 } },
        );
        vi.advanceTimersByTime(800);
      }
    });
    expect(calls).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test("cache hits store nothing, so finding one reads the same however many came before", async () => {
  const calls: Calls = [];
  const agent = makeAgent({ experimental_decisionModel: decisionModel(calls) });
  const t = initConvexTest({
    transactionLimits: { bytesRead: 1 << 20, documentsRead: 50 },
  });
  const stored = await t.action(async (ctx) => {
    const { threadId } = await seedThread(ctx);
    for (let i = 0; i < 200; i++) {
      await agent.experimental_decide(
        ctx,
        { threadId },
        { questions, state: "x".repeat(100_000), cache: { ttlMs: 60_000 } },
      );
    }
    return (await list(ctx, threadId, questions)).page.length;
  });
  expect(calls).toHaveLength(1);
  expect(stored).toBe(1);
});

test("the cache finds the decision with the same inputs past any number with other settings", async () => {
  const calls: Calls = [];
  const agent = makeAgent({ experimental_decisionModel: decisionModel(calls) });
  const t = initConvexTest({ transactionLimits: { bytesRead: 1 << 20 } });
  const cached = await t.action(async (ctx) => {
    const { threadId } = await seedThread(ctx);
    const decide = (maxOutputTokens: number) =>
      agent.experimental_decide(
        ctx,
        { threadId },
        {
          questions,
          state: "x".repeat(100_000),
          maxOutputTokens,
          cache: { ttlMs: 60_000 },
        },
      );
    await decide(1);
    for (let i = 2; i <= 21; i++) await decide(i);
    return (await decide(1)).cached;
  });
  expect(cached).toBe(true);
  expect(calls).toHaveLength(21);
});

test("the cache keys on the provider, the model and the settings that change the answer", async () => {
  const calls: Calls = [];
  const typesafe = decisionModel(calls);
  const other = new Experimental_DecisionMockModelV4({
    provider: "other",
    modelId: "jev-1.14",
    doDecide: (options) => typesafe.doDecide(options),
  });
  const agent = makeAgent({ experimental_decisionModel: typesafe });
  const stored = await initConvexTest().action(async (ctx) => {
    const { threadId } = await seedThread(ctx);
    const decide = (
      args: Partial<Parameters<typeof agent.experimental_decide>[2]>,
    ) =>
      agent.experimental_decide(
        ctx,
        { threadId },
        { questions, cache: { ttlMs: 60_000 }, ...args },
      );
    await decide({});
    await decide({ model: other });
    await decide({ reasoning: "high" });
    await decide({ maxOutputTokens: 64 });
    await decide({ providerOptions: { typesafe: { a: 1, b: 2 } } });
    await decide({ providerOptions: { typesafe: { b: 2, a: 1 } } });
    await decide({});
    const { page } = await list(ctx, threadId, questions);
    return page.reverse().map((d) => d.settings ?? null);
  });
  expect(calls).toHaveLength(5);
  expect(stored).toEqual([
    null,
    null,
    { reasoning: "high" },
    { maxOutputTokens: 64 },
    { providerOptions: { typesafe: { a: 1, b: 2 } } },
  ]);
});

test("correcting an asked question stops the cache reusing decisions with the same inputs", async () => {
  const calls: Calls = [];
  const agent = makeAgent({ experimental_decisionModel: decisionModel(calls) });
  await initConvexTest().action(async (ctx) => {
    const { threadId } = await seedThread(ctx);
    const decide = (cache?: { ttlMs: number }) =>
      agent.experimental_decide(ctx, { threadId }, { questions, cache });
    const correct = (decisionId: string | undefined) =>
      experimental_correctDecision(ctx, components.agent, {
        threadId,
        decisionId: decisionId!,
        questions,
        questionId: "intent",
        answer: { type: "choice", choice: "compare" },
      });
    const cache = { ttlMs: 60_000 };
    await decide();
    await correct((await decide()).decisionId);
    // Only the newest decision with these inputs is returned, not the older one.
    await decide(cache);
    // A hit returns that newest decision, so this corrects it.
    await correct((await decide(cache)).decisionId);
    await decide(cache);
  });
  expect(calls).toHaveLength(4);
});

describe("a question's identity is its ID, its version is its definition", () => {
  const reworded = {
    ...questions,
    intent: {
      ...questions.intent,
      instructions: "What is the user asking for?",
      criteria: { status: "where things stand", compare: "how two differ" },
    },
  } as const;
  const grown = {
    ...questions,
    urgent: { type: "boolean", instructions: "Is it urgent?" },
  } as const;
  const rekeyed = {
    intent: {
      type: "choice",
      criteria: { status: "a status update", diff: "a comparison" },
    },
  } as const;
  const scored = {
    level: { type: "score", criteria: ["none", "some", "most", "all"] },
  } as const;

  test("listing by questions keeps reworded, grown and trimmed question sets, typed, and leaves out changed option keys and levels", async () => {
    const out = await initConvexTest().action(async (ctx) => {
      const agent = makeAgent({});
      const { threadId } = await seedThread(ctx);
      await agent.experimental_decide(ctx, { threadId }, { questions });
      await agent.experimental_decide(ctx, { threadId }, { questions: grown });
      await agent.experimental_decide(ctx, { threadId }, { questions: scored });
      const keys = async (q: Record<string, Experimental_DecisionQuestion>) =>
        (await list(ctx, threadId, q)).page.map((d) =>
          Object.keys(d.answers).sort(),
        );
      const page = (await list(ctx, threadId, reworded)).page;
      expectTypeOf(page[0].answers.intent).toEqualTypeOf<
        | {
            type: "choice";
            choice: "status" | "compare";
            probabilities?: Record<"status" | "compare", number>;
          }
        | undefined
      >();
      return {
        reworded: await keys(reworded),
        grown: await keys(grown),
        trimmed: await keys({ ambiguous: questions.ambiguous }),
        rekeyed: await keys(rekeyed),
        scored: await keys({
          level: { ...scored.level, instructions: "How much?" },
        }),
        rescaled: await keys({
          level: { type: "score", criteria: ["none", "all"] },
        }),
        none: await keys({}),
        asked: page.map(
          (d) => (d.questions.intent as { instructions?: string }).instructions,
        ),
      };
    });
    expect(out).toEqual({
      reworded: [
        ["ambiguous", "intent"],
        ["ambiguous", "intent"],
      ],
      grown: [
        ["ambiguous", "intent", "urgent"],
        ["ambiguous", "intent"],
      ],
      trimmed: [["ambiguous"], ["ambiguous"]],
      rekeyed: [],
      scored: [["level"]],
      rescaled: [],
      none: [],
      asked: ["What does the user want?", "What does the user want?"],
    });
  });

  test("a listed page holds numItems matching decisions among other and incompatible ones", async () => {
    const sizes = await initConvexTest().action(async (ctx) => {
      const agent = makeAgent({});
      const { threadId } = await seedThread(ctx);
      const other = {
        mood: { type: "boolean", instructions: "Upset?" },
      } as const;
      for (let i = 0; i < 3; i++) {
        for (const q of [reworded, rekeyed, other]) {
          await agent.experimental_decide(ctx, { threadId }, { questions: q });
        }
      }
      const sizes: number[] = [];
      let cursor: string | null = null;
      for (;;) {
        const result: {
          page: unknown[];
          isDone: boolean;
          continueCursor: string;
        } = await experimental_listDecisions(ctx, components.agent, {
          threadId,
          questions: {
            intent: questions.intent,
            ambiguous: questions.ambiguous,
          },
          paginationOpts: { numItems: 2, cursor },
        });
        sizes.push(result.page.length);
        if (result.isDone) return sizes;
        cursor = result.continueCursor;
      }
    });
    expect(sizes).toEqual([2, 1]);
  });
});

test("a correction keeps the model's answer, and a later correction of the question replaces it", async () => {
  const agent = makeAgent({});
  const row = await initConvexTest().action(async (ctx) => {
    const { threadId } = await seedThread(ctx);
    const { decisionId } = await agent.experimental_decide(
      ctx,
      { threadId },
      { questions },
    );
    for (const by of ["escalation", "robel"]) {
      await experimental_correctDecision(ctx, components.agent, {
        threadId,
        decisionId: decisionId!,
        questions,
        questionId: "intent",
        answer: { type: "choice", choice: "compare" },
        by,
      });
    }
    return (await list(ctx, threadId, questions)).page[0];
  });
  expect(row.answers.intent?.choice).toBe("status");
  expect(row.corrections).toEqual({
    intent: { answer: { type: "choice", choice: "compare" }, by: "robel" },
  });
});

test("a correction is refused for another thread's decision the same way as for a missing one", async () => {
  const agent = makeAgent({});
  const out = await initConvexTest().action(async (ctx) => {
    const mine = await seedThread(ctx);
    const theirs = await seedThread(ctx, "u2");
    const { decisionId } = await agent.experimental_decide(
      ctx,
      { threadId: theirs.threadId },
      { questions },
    );
    const correct = () =>
      experimental_correctDecision(ctx, components.agent, {
        threadId: mine.threadId,
        decisionId: decisionId!,
        questions,
        questionId: "intent",
        answer: { type: "choice", choice: "compare" },
      }).then(
        () => "corrected",
        (e: Error) => e.message,
      );
    const otherThread = await correct();
    const [stored] = (await list(ctx, theirs.threadId, questions)).page;
    await agent.deleteThreadSync(ctx, { threadId: theirs.threadId });
    return { otherThread, missing: await correct(), stored };
  });
  expect(out.otherThread).toMatch(/has no decision/);
  expect(out.missing).toBe(out.otherThread);
  expect(out.stored.corrections).toEqual({});
});

test("a correction must answer the question as it was asked", async () => {
  const agent = makeAgent({});
  const asked = {
    ...questions,
    level: { type: "score", criteria: ["none", "some", "all"] },
    chart: { type: "box", instructions: "Where is the chart?" },
    many: {
      type: "choice",
      criteria: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`o${i}`, `option ${i}`]),
      ),
    },
  } as const;
  const out = await initConvexTest().action(async (ctx) => {
    const { threadId } = await seedThread(ctx);
    const { decisionId } = await agent.experimental_decide(
      ctx,
      { threadId },
      { questions: asked },
    );
    const correct = (questionId: string, answer: unknown) =>
      experimental_correctDecision(ctx, components.agent, {
        threadId,
        decisionId: decisionId!,
        questionId,
        answer: answer as never,
      }).then(
        () => "corrected",
        (e: Error) => e.message,
      );
    return {
      refused: [
        await correct("intent", { type: "boolean", probability: 1 }),
        await correct("intent", { type: "choice", choice: "other" }),
        await correct("level", { type: "score", score: 3 }),
        await correct("level", {
          type: "score",
          score: 2,
          probabilities: { "2": 0.5, "3": 0.5 },
        }),
        await correct("ambiguous", { type: "boolean", probability: 1.5 }),
        await correct("intent", {
          type: "choice",
          choice: "status",
          probabilities: { status: 0.6, compare: 0.6 },
        }),
        await correct("chart", {
          type: "box",
          box: { top: 0.8, bottom: 0.2, left: 0, right: 1 },
        }),
        await correct("intent", {
          type: "choice",
          choice: "status",
          probabilities: { status: 1 },
        }),
        await correct("many", {
          type: "choice",
          choice: "o0",
          probabilities: Object.fromEntries(
            Object.keys(asked.many.criteria).map((key) => [key, 0]),
          ),
        }),
      ],
      accepted: await correct("level", { type: "score", score: 2 }),
      corrections: (await list(ctx, threadId, asked)).page[0].corrections,
    };
  });
  expect(out.refused).toEqual(
    Array(9).fill(expect.stringMatching(/isn't an answer to/)),
  );
  expect(out.accepted).toBe("corrected");
  expect(out.corrections).toEqual({
    level: { answer: { type: "score", score: 2 } },
  });
});

test("answer types follow the questions through decide, listing and corrections", async () => {
  const agent = makeAgent({});
  await initConvexTest().action(async (ctx) => {
    const { threadId } = await seedThread(ctx);
    const { answers, decisionId } = await agent.experimental_decide(
      ctx,
      { threadId },
      { questions },
    );
    expectTypeOf(questions).toMatchTypeOf<DecisionQuestions>();
    expectTypeOf<
      Parameters<typeof agent.experimental_decide<typeof questions>>[2]
    >().toEqualTypeOf<DecideArgs<typeof questions>>();
    expectTypeOf<
      Awaited<ReturnType<typeof agent.experimental_decide<typeof questions>>>
    >().toEqualTypeOf<DecideResult<typeof questions>>();
    expectTypeOf(answers.intent.choice).toEqualTypeOf<"status" | "compare">();
    expectTypeOf(answers.ambiguous.probability).toEqualTypeOf<number>();
    expectTypeOf(decisionId).toEqualTypeOf<string | undefined>();
    const { page } = await experimental_listDecisions(ctx, components.agent, {
      threadId,
      questions,
      paginationOpts: firstPage,
    });
    expectTypeOf(page[0]).toEqualTypeOf<DecisionDoc<typeof questions>>();
    // @ts-expect-error not a question
    void page[0].answers.missing;
    await expect(
      experimental_correctDecision(ctx, components.agent, {
        threadId,
        decisionId: page[0]._id,
        questions,
        questionId: "intent",
        // @ts-expect-error not an option
        answer: { type: "choice", choice: "other" },
      }),
    ).rejects.toThrow(/isn't an answer/);
  });
});
