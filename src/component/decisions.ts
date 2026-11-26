import { paginationOptsValidator } from "convex/server";
import { mergedStream, stream } from "convex-helpers/server/stream";
import { assert, pick } from "convex-helpers";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { schema, v } from "./schema.js";
import { answersQuestion, sumsToOne } from "../decisions.js";
import {
  vDecisionAnswer,
  vDecisionDoc,
  vPaginationResult,
} from "../validators.js";

const answerFields = schema.tables.decisionAnswers.validator.fields;

export const create = mutation({
  args: {
    ...schema.tables.decisions.validator.fields,
    answers: v.array(
      v.object(
        pick(answerFields, [
          "questionId",
          "definitionHash",
          "shapeHash",
          "answer",
        ]),
      ),
    ),
  },
  returns: v.id("decisions"),
  handler: async (ctx, { answers, ...decision }) => {
    const thread = await ctx.db.get("threads", decision.threadId);
    assert(thread, `Thread ${decision.threadId} not found`);
    const decisionId = await ctx.db.insert("decisions", decision);
    for (const answer of answers) {
      await ctx.db.insert("decisionAnswers", {
        ...answer,
        decisionId,
        threadId: decision.threadId,
      });
    }
    return decisionId;
  },
});

function answersOf(ctx: QueryCtx, decisionId: Id<"decisions">) {
  return ctx.db
    .query("decisionAnswers")
    .withIndex("decisionId_questionId", (q) => q.eq("decisionId", decisionId))
    .collect();
}

function toDoc(decision: Doc<"decisions">, rows: Doc<"decisionAnswers">[]) {
  return {
    ...decision,
    answers: Object.fromEntries(rows.map((r) => [r.questionId, r.answer])),
    corrections: Object.fromEntries(
      rows.flatMap((r) => (r.correction ? [[r.questionId, r.correction]] : [])),
    ),
  };
}

const vAsked = v.object(pick(answerFields, ["questionId", "shapeHash"]));

export const list = query({
  args: {
    threadId: v.id("threads"),
    /** Only decisions that answered one of these questions at that shape. */
    asked: v.optional(v.array(vAsked)),
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginationResult(vDecisionDoc),
  handler: async (ctx, { threadId, asked, paginationOpts }) => {
    if (asked?.length === 0) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    if (!asked) {
      const result = await ctx.db
        .query("decisions")
        .withIndex("threadId", (q) => q.eq("threadId", threadId))
        .order("desc")
        .paginate(paginationOpts);
      const page = await Promise.all(
        result.page.map(async (d) => toDoc(d, await answersOf(ctx, d._id))),
      );
      return { ...result, page };
    }
    const wanted = new Set(asked.map((a) => `${a.questionId}\n${a.shapeHash}`));
    const matching = new Map<string, Promise<Doc<"decisionAnswers">[]>>();
    const matchingOf = (decisionId: Id<"decisions">) => {
      let rows = matching.get(decisionId);
      if (!rows) {
        rows = answersOf(ctx, decisionId).then((rows) =>
          rows.filter((r) => wanted.has(`${r.questionId}\n${r.shapeHash}`)),
        );
        matching.set(decisionId, rows);
      }
      return rows;
    };
    // Paged over the matching answer rows, so a page is never short for the
    // decisions that don't match. A decision is listed at its first matching
    // row only, so it appears once.
    const result = await mergedStream(
      asked.map(({ questionId, shapeHash }) =>
        stream(ctx.db, schema)
          .query("decisionAnswers")
          .withIndex("threadId_questionId_shapeHash", (q) =>
            q
              .eq("threadId", threadId)
              .eq("questionId", questionId)
              .eq("shapeHash", shapeHash),
          )
          .order("desc"),
      ),
      ["_creationTime"],
    )
      .filterWith(
        async (row) => (await matchingOf(row.decisionId))[0]._id === row._id,
      )
      .paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map(async (row) => {
        const decision = await ctx.db.get("decisions", row.decisionId);
        if (!decision) {
          throw new Error(
            `Answer ${row._id} has no decision ${row.decisionId}`,
          );
        }
        return toDoc(decision, await matchingOf(row.decisionId));
      }),
    );
    return { ...result, page };
  },
});

/**
 * The newest decision since `notBefore` with the same `cacheKey`, if it
 * answered every asked question at the same version and none of those answers
 * was corrected.
 */
export const findCached = query({
  args: {
    threadId: v.id("threads"),
    cacheKey: v.string(),
    notBefore: v.number(),
    asked: v.array(
      v.object(pick(answerFields, ["questionId", "definitionHash"])),
    ),
  },
  returns: v.union(vDecisionDoc, v.null()),
  handler: async (ctx, args) => {
    const decision = await ctx.db
      .query("decisions")
      .withIndex("cacheKey_threadId", (q) =>
        q
          .eq("cacheKey", args.cacheKey)
          .eq("threadId", args.threadId)
          .gte("_creationTime", args.notBefore),
      )
      .order("desc")
      .first();
    if (!decision) return null;
    const rows = await answersOf(ctx, decision._id);
    const answered = args.asked.every(({ questionId, definitionHash }) =>
      rows.some(
        (r) =>
          r.questionId === questionId &&
          r.definitionHash === definitionHash &&
          !r.correction,
      ),
    );
    return answered ? toDoc(decision, rows) : null;
  },
});

export const correct = mutation({
  args: {
    threadId: v.id("threads"),
    decisionId: v.id("decisions"),
    questionId: v.string(),
    answer: vDecisionAnswer,
    by: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { threadId, decisionId, questionId, answer, by }) => {
    const decision = await ctx.db.get("decisions", decisionId);
    if (decision?.threadId !== threadId) {
      throw new Error(`Thread ${threadId} has no decision ${decisionId}`);
    }
    const row = await ctx.db
      .query("decisionAnswers")
      .withIndex("decisionId_questionId", (q) =>
        q.eq("decisionId", decisionId).eq("questionId", questionId),
      )
      .unique();
    if (!row) {
      throw new Error(`Decision ${decisionId} has no question ${questionId}`);
    }
    if (
      !answersQuestion(decision.questions[questionId], answer) ||
      !sumsToOne(answer)
    ) {
      throw new Error(
        `That isn't an answer to ${questionId} as decision ${decisionId} asked it`,
      );
    }
    await ctx.db.patch("decisionAnswers", row._id, {
      correction: { answer, by },
    });
    return null;
  },
});
