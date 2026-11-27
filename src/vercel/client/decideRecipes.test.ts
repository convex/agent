// The recipes in docs/decisions.mdx, built only from public APIs.
import { expect, test } from "vitest";
import type { Experimental_DecisionModel } from "ai";
import { Experimental_DecisionMockModelV4 } from "ai/test";
import type {
  Experimental_DecisionModelV4Answer,
  Experimental_DecisionModelV4CallOptions,
} from "@ai-sdk/provider";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  Agent,
  createThread,
  docsToModelMessages,
  experimental_correctDecision,
  experimental_listDecisions,
  saveMessage,
  vDecisionDoc,
  vPaginationResult,
} from "../index.js";
import type { ActionCtx } from "./types.js";
import { app, components, initConvexTest } from "./setup.test.js";
import { mockModel } from "./mockModel.js";

const triage = {
  team: {
    type: "choice",
    instructions: "Which team should handle this?",
    criteria: { billing: "payments and refunds", tech: "login and bugs" },
  },
} as const;

type Calls = Experimental_DecisionModelV4CallOptions[];

function decisionModel(
  calls: Calls,
  { choice = "billing", p = 0.9, modelId = "jev-1.14" } = {},
) {
  return new Experimental_DecisionMockModelV4({
    provider: "typesafe",
    modelId,
    doDecide: async (options) => {
      calls.push(options);
      const answers: Record<string, Experimental_DecisionModelV4Answer> = {};
      for (const [id, question] of Object.entries(options.questions)) {
        if (question.type !== "choice") throw new Error("choice only");
        const keys = Object.keys(question.criteria);
        const chosen = keys.includes(choice) ? choice : keys[0];
        answers[id] = {
          type: "choice",
          choice: chosen,
          probabilities: Object.fromEntries(
            keys.map((k) => [
              k,
              k === chosen ? p : (1 - p) / (keys.length - 1),
            ]),
          ),
        };
      }
      return {
        answers,
        usage: { inputTokens: 50, outputTokens: 1 },
        warnings: [],
        response: { modelId: `typesafe/${modelId}-20261014` },
      };
    },
  });
}

const firstPage = { numItems: 10, cursor: null };

// Recipe: replay stored decisions against another model.
async function replay(
  ctx: ActionCtx,
  agent: Agent,
  threadId: string,
  model: Experimental_DecisionModel,
) {
  const { page } = await experimental_listDecisions(ctx, components.agent, {
    threadId,
    questions: triage,
    paginationOpts: { numItems: 100, cursor: null },
  });
  const report = [];
  for (const decision of page) {
    const docs = await ctx.runQuery(
      components.agent.messages.getMessagesByIds,
      { messageIds: decision.contextMessageIds },
    );
    const { answers } = await agent.experimental_decide(
      ctx,
      { threadId },
      {
        questions: triage,
        model,
        messages: docsToModelMessages(docs.flatMap((d) => (d ? [d] : []))),
        state: decision.state && JSON.parse(decision.state),
      },
      {
        contextOptions: { recentMessages: 0 },
        storageOptions: { saveMessages: "none" },
      },
    );
    report.push({
      before: decision.answers.team?.choice,
      after: answers.team.choice,
      corrected: decision.corrections.team?.answer.choice,
    });
  }
  return report;
}

test("recipe: replay rebuilds the state the first model saw and compares it with the correction", async () => {
  const first: Calls = [];
  const second: Calls = [];
  const agent = new Agent(components.agent, {
    name: "t",
    languageModel: mockModel(),
    experimental_decisionModel: decisionModel(first),
  });
  const report = await initConvexTest().action(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, {});
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId,
      prompt: "can't log in",
    });
    const { decisionId } = await agent.experimental_decide(
      ctx,
      { threadId },
      {
        questions: triage,
        promptMessageId: messageId,
        state: { page: "login" },
      },
    );
    await saveMessage(ctx, components.agent, {
      threadId,
      prompt: "a later message the first decision never saw",
    });
    await experimental_correctDecision(ctx, components.agent, {
      threadId,
      decisionId: decisionId!,
      questions: triage,
      questionId: "team",
      answer: { type: "choice", choice: "tech" },
      by: "robel",
    });
    return replay(
      ctx,
      agent,
      threadId,
      decisionModel(second, { choice: "tech", modelId: "clef-flash" }),
    );
  });
  expect(second[0].state).toEqual(first[0].state);
  expect(report).toEqual([
    { before: "billing", after: "tech", corrected: "tech" },
  ]);
});

// Recipe: React reads decisions through an app query, with usePaginatedQuery.
const listTriage = app.query({
  args: { threadId: v.string(), paginationOpts: paginationOptsValidator },
  returns: vPaginationResult(vDecisionDoc),
  handler: (ctx, args) =>
    experimental_listDecisions(ctx, components.agent, {
      ...args,
      questions: triage,
    }),
});
const { api, createTest } = app.defineModules({ decisions: { listTriage } });

test("recipe: an app query returns the thread's triage decisions through vDecisionDoc", async () => {
  const t = createTest();
  const agent = new Agent(components.agent, {
    name: "t",
    languageModel: mockModel(),
    experimental_decisionModel: decisionModel([]),
  });
  const threadId = await t.action(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, {});
    await agent.experimental_decide(
      ctx,
      { threadId },
      { questions: triage, state: "help" },
    );
    await agent.experimental_decide(
      ctx,
      { threadId },
      { questions: { other: triage.team }, state: "x" },
    );
    return threadId;
  });
  const { page } = await t.query(api.decisions.listTriage, {
    threadId,
    paginationOpts: firstPage,
  });
  expect(page.map((d) => d.answers.team?.choice)).toEqual(["billing"]);
});
