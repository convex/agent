import { stream } from "convex-helpers/server/stream";
import { nullable } from "convex-helpers/validators";
import { paginationOptsValidator } from "convex/server";
import type { ObjectType } from "convex/values";
import { vPaginationResult } from "../validators.js";
import { internal } from "./_generated/api.js";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  query,
} from "./_generated/server.js";
import { schema, v } from "./schema.js";
import { repeatWhileHeadroom } from "./streams.js";
import { deleteThreadArgs, deleteThreadStep } from "./threads.js";

// Note: it only searches for users with threads
export const listUsersWithThreads = query({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const results = await stream(ctx.db, schema)
      .query("threads")
      .withIndex("userId", (q) => q.gt("userId", ""))
      .distinct(["userId"])
      .paginate(args.paginationOpts);
    return {
      ...results,
      page: results.page.map((t) => t.userId).filter((t): t is string => !!t),
    };
  },
  returns: vPaginationResult(v.string()),
});

export const deleteAllForUserId = action({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    let next: DeleteUserArgs = { userId: args.userId };
    while (true) {
      const result: DeleteUserStep = await ctx.runMutation(
        internal.users._deletePageForUserId,
        next,
      );
      if (result.isDone) break;
      next = result.next;
    }
  },
  returns: v.null(),
});

export const deleteAllForUserIdAsync = mutation({
  args: {
    userId: v.string(),
  },
  handler: (ctx, args) =>
    deleteAllForUserIdBatch(ctx, { userId: args.userId }, false),
  returns: v.boolean(),
});

const deleteUserArgs = {
  userId: v.string(),
  thread: v.optional(v.object(deleteThreadArgs)),
  // Jobs scheduled by earlier versions carry these. They restart from the
  // user's first thread, which is safe since deletion deletes what it reads.
  threadsCursor: v.optional(nullable(v.string())),
  threadInProgress: v.optional(nullable(v.id("threads"))),
  messagesCursor: v.optional(nullable(v.string())),
  streamsInProgress: v.optional(v.boolean()),
  streamOrder: v.optional(v.number()),
  deltaCursor: v.optional(v.string()),
};
type DeleteUserArgs = ObjectType<typeof deleteUserArgs>;
const deleteUserStepReturns = v.object({
  isDone: v.boolean(),
  next: v.object(deleteUserArgs),
});
type DeleteUserStep = { isDone: boolean; next: DeleteUserArgs };

export const _deleteAllForUserIdAsync = internalMutation({
  args: deleteUserArgs,
  handler: (ctx, args) => deleteAllForUserIdBatch(ctx, args, true),
  returns: v.boolean(),
});

async function deleteAllForUserIdBatch(
  ctx: MutationCtx,
  args: DeleteUserArgs,
  repeat: boolean,
): Promise<boolean> {
  let result = await deletePageForUserId(ctx, args);
  if (repeat) {
    result = await repeatWhileHeadroom(
      ctx,
      result,
      1,
      (previous, transactionLimits): Promise<DeleteUserStep> =>
        ctx.runMutation(internal.users._deletePageForUserId, previous.next, {
          transactionLimits,
        }),
    );
  }
  if (!result.isDone) {
    await ctx.scheduler.runAfter(
      0,
      internal.users._deleteAllForUserIdAsync,
      result.next,
    );
  }
  return result.isDone;
}

export const _deletePageForUserId = internalMutation({
  args: deleteUserArgs,
  handler: deletePageForUserId,
  returns: deleteUserStepReturns,
});
async function deletePageForUserId(
  ctx: MutationCtx,
  args: DeleteUserArgs,
): Promise<DeleteUserStep> {
  let thread = args.thread;
  if (!thread) {
    // Deleted threads leave the index, so the first one left is next. Finding
    // none reads the user's whole range, so a thread created meanwhile
    // conflicts with the step that finishes.
    const next = await ctx.db
      .query("threads")
      .withIndex("userId", (q) => q.eq("userId", args.userId))
      .first();
    if (!next) {
      return { isDone: true, next: { userId: args.userId } };
    }
    thread = { threadId: next._id };
  }
  const result = await deleteThreadStep(ctx, thread);
  return {
    isDone: false,
    next: {
      userId: args.userId,
      thread: result.isDone ? undefined : result.next,
    },
  };
}

export const getThreadUserId = internalQuery({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get("threads", args.threadId);
    return thread?.userId ?? null;
  },
});
