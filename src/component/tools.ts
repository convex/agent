import type { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import { encodeToolResult } from "../shared.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import { authorizeRow, REFUSED } from "./turns.js";

const vToolResult = v.object({
  toolCallId: v.string(),
  /** JSON: `{ output }` in Convex's JSON encoding, or `{ error }`. */
  result: v.string(),
});

const recordOf = (ctx: QueryCtx, messageId: Id<"messages">) =>
  ctx.db
    .query("toolSteps")
    .withIndex("messageId", (q) => q.eq("messageId", messageId))
    .first();

const resultsOf = (ctx: QueryCtx, messageId: Id<"messages">) =>
  ctx.db
    .query("toolResults")
    .withIndex("messageId_toolCallId", (q) => q.eq("messageId", messageId))
    .collect();

/**
 * A durable step's row, for a write by its turn's job or the app; the reason
 * another writer is refused.
 */
async function toolRow(
  ctx: MutationCtx,
  messageId: Id<"messages">,
): Promise<{ row: Doc<"messages"> } | { refused: string }> {
  const row = await ctx.db.get("messages", messageId);
  if (!row) return { refused: `Message ${messageId} not found` };
  try {
    await authorizeRow(ctx, row);
  } catch (error) {
    if (error instanceof Error && error.message === REFUSED) {
      return { refused: REFUSED };
    }
    throw error;
  }
  return { row };
}

/**
 * Records a step on its row. A record of another step goes with the results
 * its calls keyed by the row: a continuation's approved calls are keyed by
 * their request's message, so theirs stay.
 */
async function recordStep(
  ctx: MutationCtx,
  row: Doc<"messages">,
  step: string | undefined,
) {
  const record = await recordOf(ctx, row._id);
  if (!record) {
    await ctx.db.insert("toolSteps", {
      threadId: row.threadId,
      messageId: row._id,
      step,
    });
    return;
  }
  if (step === undefined || record.step === step) return;
  if (record.step !== undefined) {
    const stale = await ctx.db
      .query("toolResults")
      .withIndex("messageId_toolCallId", (q) =>
        q
          .eq("messageId", row._id)
          .gt("toolCallId", `${row._id}:`)
          .lt("toolCallId", `${row._id};`),
      )
      .collect();
    for (const { _id } of stale) await ctx.db.delete("toolResults", _id);
  }
  await ctx.db.patch("toolSteps", record._id, { step });
}

/** The step a dead job recorded on a row, with its calls' results, to replay. */
export const replay = query({
  args: { messageId: v.id("messages") },
  returns: v.union(
    v.null(),
    v.object({
      step: v.optional(v.string()),
      results: v.array(vToolResult),
    }),
  ),
  handler: async (ctx, { messageId }) => {
    const record = await recordOf(ctx, messageId);
    if (!record) return null;
    return {
      ...(record.step !== undefined ? { step: record.step } : {}),
      results: (await resultsOf(ctx, messageId)).map(
        ({ toolCallId, result }) => ({ toolCallId, result }),
      ),
    };
  },
});

/**
 * Records a durable step's model response before its tools run, or results
 * that end before their step's save, on its pending message. Returns why the
 * step's tools mustn't run, if they mustn't.
 */
export const recordToolStep = mutation({
  args: {
    messageId: v.id("messages"),
    step: v.optional(v.string()),
    results: v.array(vToolResult),
  },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { messageId, step, results }) => {
    const judged = await toolRow(ctx, messageId);
    if ("refused" in judged) return judged.refused;
    await recordStep(ctx, judged.row, step);
    for (const result of results) {
      await ctx.db.insert("toolResults", {
        threadId: judged.row.threadId,
        messageId,
        ...result,
      });
    }
    return null;
  },
});

/**
 * Runs an app mutation for a durable step's call and records its result in
 * the same transaction, so its writes commit exactly when its result does: a
 * retry gets the result back instead of running it again. The step's first
 * mutation records the step too, when nothing did before its calls ran.
 */
export const runToolMutation = mutation({
  args: {
    messageId: v.id("messages"),
    toolCallId: v.string(),
    handle: v.string(),
    args: v.any(),
    step: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ refused: v.string() }),
    v.object({ result: v.string() }),
  ),
  handler: async (ctx, { messageId, toolCallId, handle, args, step }) => {
    const judged = await toolRow(ctx, messageId);
    if ("refused" in judged) return judged;
    await recordStep(ctx, judged.row, step);
    const recorded = await ctx.db
      .query("toolResults")
      .withIndex("messageId_toolCallId", (q) =>
        q.eq("messageId", messageId).eq("toolCallId", toolCallId),
      )
      .first();
    if (recorded) return { result: recorded.result };
    let outcome: { output: unknown } | { error: string };
    try {
      outcome = {
        output: await ctx.runMutation(
          handle as FunctionHandle<"mutation">,
          args,
        ),
      };
    } catch (error) {
      // Its sub-transaction's writes were rolled back.
      outcome = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // Outside the try: its writes committed, so its output must be recorded.
    const result = encodeToolResult(outcome);
    await ctx.db.insert("toolResults", {
      threadId: judged.row.threadId,
      messageId,
      toolCallId,
      result,
    });
    return { result };
  },
});
