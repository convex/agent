import { stream } from "convex-helpers/server/stream";
import { deleteTurnsPage, endTurnsForDeleted } from "./turns.js";
import { nullable } from "convex-helpers/validators";
import { paginationOptsValidator } from "convex/server";
import type { ObjectType } from "convex/values";
import { vPaginationResult } from "../validators.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  query,
} from "./_generated/server.js";
import { deleteMessage } from "./messages.js";
import {
  deleteStreamsPageForThreadId,
  deletionCursor,
  repeatWhileHeadroom,
} from "./streams.js";
import { schema, v } from "./schema.js";

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
    let next: DeleteAllArgs = {
      userId: args.userId,
      messagesCursor: null,
      threadsCursor: null,
      threadInProgress: null,
    };
    for (;;) {
      const { isDone, ...cursors }: DeleteAllReturns = await ctx.runMutation(
        internal.users._deletePageForUserId,
        next,
      );
      if (isDone) return null;
      next = { userId: args.userId, ...cursors };
    }
  },
  returns: v.null(),
});

export const deleteAllForUserIdAsync = mutation({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const isDone = await deleteAllForUserIdBatch(
      ctx,
      {
        userId: args.userId,
        messagesCursor: null,
        threadsCursor: null,
        threadInProgress: null,
        streamsInProgress: false,
        streamOrder: undefined,
        deltaCursor: undefined,
      },
      false,
    );
    return isDone;
  },
  returns: v.boolean(),
});

const deleteAllArgs = {
  userId: v.string(),
  messagesCursor: nullable(v.string()),
  threadsCursor: nullable(v.string()),
  threadInProgress: nullable(v.id("threads")),
  streamsInProgress: v.optional(v.boolean()),
  streamOrder: v.optional(v.number()),
  deltaCursor: v.optional(v.string()),
  jobsCursor: v.optional(v.string()),
};
type DeleteAllArgs = ObjectType<typeof deleteAllArgs>;
const deleteAllReturns = {
  threadsCursor: v.string(),
  threadInProgress: nullable(v.id("threads")),
  messagesCursor: nullable(v.string()),
  streamsInProgress: v.optional(v.boolean()),
  streamOrder: v.optional(v.number()),
  deltaCursor: v.optional(v.string()),
  jobsCursor: v.optional(v.string()),
  isDone: v.boolean(),
};
type DeleteAllReturns = ObjectType<typeof deleteAllReturns>;

export const _deleteAllForUserIdAsync = internalMutation({
  args: deleteAllArgs,
  handler: (ctx, args) => deleteAllForUserIdBatch(ctx, args, true),
  returns: v.boolean(),
});

async function deleteAllForUserIdBatch(
  ctx: MutationCtx,
  args: DeleteAllArgs,
  repeat: boolean,
): Promise<boolean> {
  let result = await deletePageForUserId(ctx, args);
  if (repeat) {
    result = await repeatWhileHeadroom(
      ctx,
      result,
      1,
      (
        { isDone: _, ...previous },
        transactionLimits,
      ): Promise<DeleteAllReturns> =>
        ctx.runMutation(
          internal.users._deletePageForUserId,
          { userId: args.userId, ...previous },
          { transactionLimits },
        ),
    );
  }
  if (!result.isDone) {
    await ctx.scheduler.runAfter(0, internal.users._deleteAllForUserIdAsync, {
      userId: args.userId,
      messagesCursor: result.messagesCursor,
      threadsCursor: result.threadsCursor,
      threadInProgress: result.threadInProgress,
      streamsInProgress: result.streamsInProgress ?? false,
      streamOrder: result.streamOrder,
      deltaCursor: result.deltaCursor,
      jobsCursor: result.jobsCursor,
    });
  }
  return result.isDone;
}

export const _deletePageForUserId = internalMutation({
  args: deleteAllArgs,
  handler: deletePageForUserId,
  returns: deleteAllReturns,
});
async function deletePageForUserId(
  ctx: MutationCtx,
  args: DeleteAllArgs,
): Promise<DeleteAllReturns> {
  let threadInProgress: Id<"threads"> | null = args.threadInProgress;
  let threadsCursor: string | null = args.threadsCursor;
  let messagesCursor: string | null = args.messagesCursor;
  let streamsInProgress: boolean = args.streamsInProgress ?? false;
  let streamOrder: number | undefined = args.streamOrder;
  let deltaCursor: string | undefined = args.deltaCursor;
  let jobsCursor: string | undefined = args.jobsCursor;

  // Phase 1: Get a thread to work on if we don't have one
  if (!threadsCursor || !threadInProgress) {
    const threads = await ctx.db
      .query("threads")
      .withIndex("userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .paginate({
        numItems: 1,
        cursor: deletionCursor(args.threadsCursor),
      });
    threadsCursor = threads.continueCursor;
    if (threads.page.length > 0) {
      threadInProgress = threads.page[0]._id;
      messagesCursor = null;
      streamsInProgress = false;
      streamOrder = undefined;
      deltaCursor = undefined;
      jobsCursor = undefined;
    } else {
      return {
        isDone: true,
        threadsCursor,
        threadInProgress,
        messagesCursor,
        streamsInProgress,
        streamOrder,
        deltaCursor,
        jobsCursor,
      };
    }
  }

  // Phase 2: Delete messages for the current thread
  if (!streamsInProgress) {
    const messages = await ctx.db
      .query("messages")
      .withIndex("threadId_status_tool_order_stepOrder", (q) =>
        q.eq("threadId", threadInProgress!),
      )
      .order("desc")
      .paginate({
        numItems: 100,
        cursor: deletionCursor(messagesCursor),
      });
    await Promise.all(messages.page.map((m) => deleteMessage(ctx, m)));
    if (messages.page.some((m) => m.turnId)) {
      await endTurnsForDeleted(ctx, messages.page);
    }

    const turns = messages.isDone
      ? await deleteTurnsPage(ctx, threadInProgress!, jobsCursor)
      : undefined;
    if (turns?.done) {
      // Messages are done, move to streams deletion phase
      streamsInProgress = true;
      messagesCursor = null;
      streamOrder = undefined;
      deltaCursor = undefined;
      jobsCursor = undefined;
    } else {
      messagesCursor = messages.continueCursor;
      jobsCursor = turns?.jobsCursor ?? jobsCursor;
    }

    return {
      messagesCursor,
      threadsCursor,
      threadInProgress,
      streamsInProgress,
      streamOrder,
      deltaCursor,
      jobsCursor,
      isDone: false,
    };
  }

  // Phase 3: Delete streams for the current thread
  const streamResult = await deleteStreamsPageForThreadId(ctx, {
    threadId: threadInProgress!,
    streamOrder,
    deltaCursor,
  });

  if (streamResult.isDone) {
    // Streams are done, delete the thread and reset for next thread
    await ctx.db.delete("threads", threadInProgress);
    threadInProgress = null;
    messagesCursor = null;
    streamsInProgress = false;
    streamOrder = undefined;
    deltaCursor = undefined;
  } else {
    // Continue with streams deletion
    streamOrder = streamResult.streamOrder;
    deltaCursor = streamResult.deltaCursor;
  }

  return {
    messagesCursor,
    threadsCursor,
    threadInProgress,
    streamsInProgress,
    streamOrder,
    deltaCursor,
    jobsCursor,
    isDone: false,
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
