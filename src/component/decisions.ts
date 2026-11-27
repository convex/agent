import {
  paginationOptsValidator,
  type PaginationOptions,
  type PaginationResult,
} from "convex/server";
import { mergedStream, stream } from "convex-helpers/server/stream";
import { assert, pick } from "convex-helpers";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { schema, v, vStoredDecisionAnswer } from "./schema.js";
import {
  answersQuestion,
  decodeAnswer,
  decodeQuestions,
  decisionTooLarge,
  MAX_DOCUMENT_BYTES,
  sumsToOne,
} from "../decisions.js";
import { vPaginationResult } from "../validators.js";

const answerFields = schema.tables.decisionAnswers.validator.fields;

// As stored: the client decodes the JSON text.
const vStoredDecision = v.object({
  ...schema.tables.decisions.validator.fields,
  _id: v.id("decisions"),
  _creationTime: v.number(),
  answers: v.array(
    v.object(pick(answerFields, ["questionId", "answer", "correction"])),
  ),
});

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
    const rows = answers.map((answer) => ({
      ...answer,
      threadId: decision.threadId,
    }));
    const error = decisionTooLarge("The decision", decision, rows);
    if (error) throw new Error(error);
    const decisionId = await ctx.db.insert("decisions", decision);
    for (const row of rows) {
      await ctx.db.insert("decisionAnswers", { ...row, decisionId });
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
    answers: rows.map((r) => pick(r, ["questionId", "answer", "correction"])),
  };
}

const vAsked = v.object(pick(answerFields, ["questionId", "shapeHash"]));

/**
 * Reads `source` in batches that leave room for a full decision with its
 * answers per item read, ending the page once half the query's read limits are
 * used, as listDeltas keeps. A decision's size shows only once it's read. A
 * refresh up to its `endCursor` that runs out first asks for a split, as a
 * paginated query's pages must stay adjacent.
 */
async function pageWithinReadLimits<T, D>(
  ctx: QueryCtx,
  source: { paginate(opts: PaginationOptions): Promise<PaginationResult<T>> },
  opts: PaginationOptions,
  load: (item: T) => Promise<D>,
): Promise<PaginationResult<D>> {
  const { endCursor } = opts;
  const page: D[] = [];
  let cursor = opts.cursor;
  for (;;) {
    const { bytesRead, documentsRead } = await ctx.meta.getTransactionMetrics();
    const [bytesLeft, documentsLeft] = [bytesRead, documentsRead].map(
      ({ used, remaining }) => (used + remaining) / 2 - used,
    );
    if (cursor !== opts.cursor && (bytesLeft <= 0 || documentsLeft <= 0)) {
      return endCursor
        ? {
            page,
            isDone: false,
            continueCursor: endCursor,
            splitCursor: cursor,
            pageStatus: "SplitRequired",
          }
        : { page, isDone: false, continueCursor: cursor! };
    }
    const batch = Math.max(1, Math.floor(bytesLeft / MAX_DOCUMENT_BYTES));
    const result = await source.paginate(
      endCursor
        ? { numItems: batch, cursor, endCursor, maximumRowsRead: batch }
        : {
            numItems: Math.max(1, Math.min(opts.numItems - page.length, batch)),
            cursor,
          },
    );
    page.push(...(await Promise.all(result.page.map(load))));
    cursor = result.continueCursor;
    if (
      endCursor
        ? cursor === endCursor
        : result.isDone || page.length >= opts.numItems
    ) {
      return { page, isDone: result.isDone, continueCursor: cursor };
    }
  }
}

export const list = query({
  args: {
    threadId: v.id("threads"),
    /** Only decisions that answered one of these questions at that shape. */
    asked: v.optional(v.array(vAsked)),
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginationResult(vStoredDecision),
  handler: async (ctx, { threadId, asked, paginationOpts }) => {
    if (asked?.length === 0) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    if (!asked) {
      return pageWithinReadLimits(
        ctx,
        stream(ctx.db, schema)
          .query("decisions")
          .withIndex("threadId", (q) => q.eq("threadId", threadId))
          .order("desc"),
        paginationOpts,
        async (d) => toDoc(d, await answersOf(ctx, d._id)),
      );
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
    const matchingRows = mergedStream(
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
    ).filterWith(
      async (row) => (await matchingOf(row.decisionId))[0]._id === row._id,
    );
    return pageWithinReadLimits(
      ctx,
      matchingRows,
      paginationOpts,
      async (row) => {
        const decision = await ctx.db.get("decisions", row.decisionId);
        if (!decision) {
          throw new Error(
            `Answer ${row._id} has no decision ${row.decisionId}`,
          );
        }
        return toDoc(decision, await matchingOf(row.decisionId));
      },
    );
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
  returns: v.union(vStoredDecision, v.null()),
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
    answer: vStoredDecisionAnswer,
    by: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { threadId, decisionId, questionId, answer, by }) => {
    const decision = await ctx.db.get("decisions", decisionId);
    if (decision?.threadId !== threadId) {
      throw new Error(`Thread ${threadId} has no decision ${decisionId}`);
    }
    const rows = await answersOf(ctx, decisionId);
    const row = rows.find((r) => r.questionId === questionId);
    if (!row) {
      throw new Error(`Decision ${decisionId} has no question ${questionId}`);
    }
    const decoded = decodeAnswer(answer);
    if (
      !answersQuestion(
        decodeQuestions(decision.questions)[questionId],
        decoded,
      ) ||
      !sumsToOne(decoded)
    ) {
      throw new Error(
        `That isn't an answer to ${questionId} as decision ${decisionId} asked it`,
      );
    }
    const correction = { answer, by };
    const error = decisionTooLarge(
      `The decision with that correction to ${questionId}`,
      decision,
      rows.map((r) => (r === row ? { ...r, correction } : r)),
    );
    if (error) throw new Error(error);
    await ctx.db.patch("decisionAnswers", row._id, { correction });
    return null;
  },
});
