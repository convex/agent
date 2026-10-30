import { assert, omit, pick } from "convex-helpers";
import { mergedStream, stream } from "convex-helpers/server/stream";
import {
  paginationOptsValidator,
  type WithoutSystemFields,
} from "convex/server";
import type { ObjectType } from "convex/values";
import {
  DEFAULT_MESSAGE_RANGE,
  DEFAULT_RECENT_MESSAGES,
  extractText,
  isTool,
  sorted,
  withDerivedReasoning,
} from "../shared.js";
import {
  vMessageDoc,
  vMessageEmbeddingsWithDimension,
  vMessageStatus,
  vMessageWithMetadataInternal,
  vPaginationResult,
  type MessageDoc,
} from "../validators.js";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  query,
  type QueryCtx,
} from "./_generated/server.js";
import { schema, v } from "./schema.js";
import { insertVector, searchVectors } from "./vector/index.js";
import {
  getVectorIdInfo,
  validateVectorDimension,
  type VectorTableId,
  vVectorId,
} from "./vector/tables.js";
import { changeRefcount } from "./files.js";
import {
  getStreamingMessagesWithMetadata,
  finishHandler,
  releaseStreamFileOwnershipByIds,
  abortStreamsAtOrder,
} from "./streams.js";
import { partial } from "convex-helpers/validators";
import {
  APPROVAL_LOOKUP_MESSAGES,
  planToolCallApprovals,
} from "../approvals.js";

function publicMessage(message: Doc<"messages">): MessageDoc {
  return withDerivedReasoning(
    omit(message, ["parentMessageId", "stepId", "files"]),
  );
}

export async function deleteMessage(
  ctx: MutationCtx,
  messageDoc: Doc<"messages">,
) {
  await ctx.db.delete("messages", messageDoc._id);
  if (messageDoc.embeddingId) {
    const { tableName } = getVectorIdInfo(ctx, messageDoc.embeddingId);
    await ctx.db.delete(tableName, messageDoc.embeddingId);
  }
  if (messageDoc.fileIds) {
    await changeRefcount(ctx, messageDoc.fileIds, []);
  }
}

/**
 * Deleting a message strands any generation still writing to its order, which
 * would otherwise only surface as a missing-parent failure when that generation
 * finalizes. Aborting the stream lets the in-flight run stop on its own.
 */
async function abortStreamsForDeleted(
  ctx: MutationCtx,
  deleted: (Doc<"messages"> | null)[],
) {
  const seen = new Set<string>();
  for (const message of deleted) {
    if (!message) continue;
    const key = `${message.threadId}:${message.order}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await abortStreamsAtOrder(ctx, {
      threadId: message.threadId,
      order: message.order,
      reason: "Message deleted",
    });
  }
}

export const deleteByIds = mutation({
  args: { messageIds: v.array(v.id("messages")) },
  returns: v.array(v.id("messages")),
  handler: async (ctx, args) => {
    const deleted = await Promise.all(
      args.messageIds.map(async (id) => {
        const message = await ctx.db.get("messages", id);
        if (message) {
          await deleteMessage(ctx, message);
          return message;
        }
        return null;
      }),
    );
    await abortStreamsForDeleted(ctx, deleted);
    return deleted.filter((m) => m !== null).map((m) => m._id);
  },
});

export const messageStatuses = vMessageDoc.fields.status.members.map(
  (m) => m.value,
);

const STREAM_RECOVERY_FAILURE =
  "Failed to recover persisted assistant stream output";

async function markPendingMessageFailed(
  ctx: MutationCtx,
  message: Doc<"messages">,
  error: string,
) {
  if (message.embeddingId) {
    const { tableName } = getVectorIdInfo(ctx, message.embeddingId);
    await ctx.db.delete(tableName, message.embeddingId);
  }
  await ctx.db.patch("messages", message._id, {
    status: "failed",
    error,
    embeddingId: undefined,
  });
}

export const deleteByOrder = mutation({
  args: {
    threadId: v.id("threads"),
    startOrder: v.number(),
    startStepOrder: v.optional(v.number()),
    endOrder: v.number(),
    endStepOrder: v.optional(v.number()),
  },
  returns: v.object({
    isDone: v.boolean(),
    lastOrder: v.optional(v.number()),
    lastStepOrder: v.optional(v.number()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    isDone: boolean;
    lastOrder?: number;
    lastStepOrder?: number;
  }> => {
    const messages = await orderedMessagesStream(ctx, {
      threadId: args.threadId,
      sortOrder: "asc",
      startOrder: args.startOrder,
      startOrderBound: "gte",
    })
      .narrow({
        lowerBound: args.startStepOrder
          ? [args.startOrder, args.startStepOrder]
          : [args.startOrder],
        lowerBoundInclusive: true,
        upperBound: args.endStepOrder
          ? [args.endOrder, args.endStepOrder]
          : [args.endOrder],
        upperBoundInclusive: false,
      })
      .take(64);
    await Promise.all(messages.map((m) => deleteMessage(ctx, m)));
    await abortStreamsForDeleted(ctx, messages);
    return {
      isDone: messages.length < 64,
      lastOrder: messages.at(-1)?.order,
      lastStepOrder: messages.at(-1)?.stepOrder,
    };
  },
});

const addMessagesArgs = {
  userId: v.optional(v.string()),
  threadId: v.id("threads"),
  promptMessageId: v.optional(v.id("messages")),
  /**
   * For saves that belong to a run anchored on promptMessageId: if that
   * message is gone the run is obsolete, so abandon the save instead of
   * throwing. A caller passing an id that never existed still gets an error.
   */
  abandonIfPromptMissing: v.optional(v.boolean()),
  order: v.optional(v.union(v.number(), v.literal("next"))),
  agentName: v.optional(v.string()),
  messages: v.array(vMessageWithMetadataInternal),
  embeddings: v.optional(vMessageEmbeddingsWithDimension),
  failPendingSteps: v.optional(v.boolean()),
  // A pending message to update. If the pending message failed, abort.
  pendingMessageId: v.optional(v.id("messages")),
  // if set to true, these messages will not show up in text or vector search
  // results for the userId
  hideFromUserIdSearch: v.optional(v.boolean()),
  // If provided, finish this stream atomically with the message save.
  // This prevents UI flickering from separate mutations (issue #181).
  finishStreamId: v.optional(v.id("streamingMessages")),
};
export const addMessages = mutation({
  args: addMessagesArgs,
  handler: addMessagesHandler,
  returns: v.object({ messages: v.array(vMessageDoc) }),
});

function incrementMessagePosition(value: number, field: "order" | "stepOrder") {
  assert(
    Number.isSafeInteger(value) && value < Number.MAX_SAFE_INTEGER,
    `${field} cannot be incremented past Number.MAX_SAFE_INTEGER`,
  );
  return value + 1;
}

async function addMessagesHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof addMessagesArgs>,
) {
  let userId = args.userId;
  const threadId = args.threadId;
  if (!userId && args.threadId) {
    const thread = await ctx.db.get("threads", args.threadId);
    assert(thread, `Thread ${args.threadId} not found`);
    userId = thread.userId;
  }
  const {
    embeddings,
    failPendingSteps,
    // Destructured separately to exclude from `...rest` (used in addMessages args, not message fields)
    finishStreamId,
    messages,
    promptMessageId,
    abandonIfPromptMissing,
    order: requestedOrder,
    pendingMessageId,
    hideFromUserIdSearch,
    ...rest
  } = args;
  const promptMessage =
    promptMessageId && (await ctx.db.get("messages", promptMessageId));
  assert(
    requestedOrder === undefined ||
      requestedOrder === "next" ||
      (Number.isSafeInteger(requestedOrder) &&
        requestedOrder >= 0 &&
        requestedOrder < Number.MAX_SAFE_INTEGER),
    "order must be a non-negative safe integer less than Number.MAX_SAFE_INTEGER",
  );
  assert(
    requestedOrder === undefined || !promptMessageId,
    "order and promptMessageId cannot both be provided",
  );
  assert(
    requestedOrder === undefined || !pendingMessageId,
    "order and pendingMessageId cannot both be provided",
  );
  if (failPendingSteps) {
    assert(args.threadId, "threadId is required to fail pending steps");
    const pendingMessages = await ctx.db
      .query("messages")
      .withIndex("threadId_status_tool_order_stepOrder", (q) =>
        q.eq("threadId", threadId).eq("status", "pending"),
      )
      .order("desc")
      .take(100);
    await Promise.all(
      pendingMessages
        .filter((m) => !promptMessage || m.order === promptMessage.order)
        .filter((m) => !pendingMessageId || m._id !== pendingMessageId)
        .map(async (m) => {
          if (m.embeddingId) {
            const { tableName } = getVectorIdInfo(ctx, m.embeddingId);
            await ctx.db.delete(tableName, m.embeddingId);
          }
          await ctx.db.patch("messages", m._id, {
            status: "failed",
            error: "Restarting",
            embeddingId: undefined,
          });
        }),
    );
  }
  let order, stepOrder;
  let fail = false;
  let error: string | undefined;
  const startsAtNextOrder = requestedOrder === "next";
  const explicitOrder =
    typeof requestedOrder === "number" ? requestedOrder : undefined;
  if (startsAtNextOrder) {
    const maxMessage = await getMaxMessage(ctx, threadId);
    order = incrementMessagePosition(maxMessage?.order ?? -1, "order");
    stepOrder = -1;
  } else if (explicitOrder !== undefined) {
    order = explicitOrder;
    const maxMessage = await getMaxMessage(ctx, threadId, order);
    stepOrder = maxMessage?.stepOrder ?? -1;
  } else if (promptMessageId) {
    if (!promptMessage && abandonIfPromptMissing) {
      return { messages: [] };
    }
    assert(promptMessage, `Parent message ${promptMessageId} not found`);
    if (promptMessage.status === "failed") {
      fail = true;
      error = promptMessage.error ?? error ?? "The prompt message failed";
    }
    order = promptMessage.order;
    // Defend against there being existing messages with this parent.
    const maxMessage = await getMaxMessage(ctx, threadId, order);
    stepOrder = maxMessage?.stepOrder ?? promptMessage.stepOrder;
  } else {
    const maxMessage = await getMaxMessage(ctx, threadId);
    order = maxMessage?.order ?? -1;
    stepOrder = maxMessage?.stepOrder ?? -1;
  }
  const toReturn: Doc<"messages">[] = [];
  if (embeddings) {
    assert(
      embeddings.vectors.length === messages.length,
      "embeddings.vectors.length must match messages.length",
    );
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    let embeddingId: VectorTableId | undefined;
    if (
      embeddings &&
      embeddings.vectors[i] &&
      !fail &&
      message.status !== "failed"
    ) {
      embeddingId = await insertVector(ctx, embeddings.dimension, {
        vector: embeddings.vectors[i]!,
        model: embeddings.model,
        table: "messages",
        userId: hideFromUserIdSearch ? undefined : userId,
        threadId,
      });
    }
    const messageDoc = {
      ...rest,
      ...message,
      embeddingId,
      parentMessageId: promptMessageId,
      userId,
      tool: isTool(message.message),
      text: hideFromUserIdSearch ? undefined : extractText(message.message),
      status: fail ? "failed" : (message.status ?? "success"),
      error: fail ? error : message.error,
    } satisfies Omit<
      WithoutSystemFields<Doc<"messages">>,
      "order" | "stepOrder"
    >;
    // If there is a pending message, we replace that one with the first message
    // and subsequent ones will follow the regular order/subOrder advancement.
    if (i === 0 && pendingMessageId) {
      const pendingMessage = await ctx.db.get("messages", pendingMessageId);
      assert(pendingMessage, `Pending msg ${pendingMessageId} not found`);
      if (pendingMessage.status === "failed") {
        fail = true;
        error =
          pendingMessage.error ??
          `Trying to update a message that failed: ${pendingMessageId}`;
        messageDoc.status = "failed";
        messageDoc.error = error;
      }
      if (message.fileIds) {
        await changeRefcount(
          ctx,
          pendingMessage.fileIds ?? [],
          message.fileIds,
        );
      }
      await ctx.db.replace("messages", pendingMessage._id, {
        ...messageDoc,
        order: pendingMessage.order,
        stepOrder: pendingMessage.stepOrder,
      });
      toReturn.push((await ctx.db.get("messages", pendingMessage._id))!);
      continue;
    }
    if ((startsAtNextOrder || explicitOrder !== undefined) && i === 0) {
      stepOrder = incrementMessagePosition(stepOrder, "stepOrder");
    } else if (message.message.role === "user") {
      if (
        (explicitOrder !== undefined && order === explicitOrder) ||
        (promptMessage && promptMessage.order === order)
      ) {
        // Avoid colliding with a later order when saving from an older one.
        const maxMessage = await getMaxMessage(ctx, threadId);
        order = incrementMessagePosition(
          Math.max(maxMessage?.order ?? order, order),
          "order",
        );
      } else {
        order = incrementMessagePosition(order, "order");
      }
      stepOrder = 0;
    } else {
      if (order < 0) {
        order = 0;
      }
      stepOrder = incrementMessagePosition(stepOrder, "stepOrder");
    }
    const messageId = await ctx.db.insert("messages", {
      ...messageDoc,
      order,
      stepOrder,
    });
    if (message.fileIds) {
      await changeRefcount(ctx, [], message.fileIds);
    }
    // TODO: delete the associated stream data for the order/stepOrder
    toReturn.push((await ctx.db.get("messages", messageId))!);
  }
  // Atomically finish the stream if requested, preventing UI flickering
  // from separate mutations for message save and stream finish (issue #181).
  if (finishStreamId) {
    await finishHandler(ctx, {
      streamId: finishStreamId,
    });
    await releaseStreamFileOwnershipByIds(ctx, [finishStreamId]);
  }
  return { messages: toReturn.map(publicMessage) };
}

// exported for tests
export async function getMaxMessage(
  ctx: QueryCtx,
  threadId: Id<"threads">,
  order?: number,
) {
  return orderedMessagesStream(ctx, {
    threadId,
    sortOrder: "desc",
    startOrder: order,
    startOrderBound: "eq",
  }).first();
}

function orderedMessagesStream(
  ctx: QueryCtx,
  args: {
    threadId: Id<"threads">;
    sortOrder: "asc" | "desc";
    startOrder?: number;
    startOrderBound?: "gte" | "eq";
  },
) {
  return mergedStream(
    [true, false].flatMap((tool) =>
      messageStatuses.map((status) =>
        stream(ctx.db, schema)
          .query("messages")
          .withIndex("threadId_status_tool_order_stepOrder", (q) => {
            const qq = q
              .eq("threadId", args.threadId)
              .eq("status", status)
              .eq("tool", tool);
            if (args.startOrder !== undefined) {
              if (args.startOrderBound === "gte") {
                return qq.gte("order", args.startOrder);
              } else {
                return qq.eq("order", args.startOrder);
              }
            }
            return qq;
          })
          .order(args.sortOrder),
      ),
    ),
    ["order", "stepOrder"],
  );
}

export const finalizeMessage = mutation({
  args: {
    messageId: v.id("messages"),
    result: v.union(
      v.object({ status: v.literal("success") }),
      v.object({ status: v.literal("failed"), error: v.string() }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { messageId, result }) => {
    const message = await ctx.db.get("messages", messageId);
    assert(message, `Message ${messageId} not found`);
    if (message.status !== "pending") {
      console.debug(
        "Trying to finalize a message that's already",
        message.status,
      );
      return;
    }
    // See if we can add any in-progress data
    if (!message.message?.content.length) {
      const { messages, materializationFailures, streamsToRelease } =
        await getStreamingMessagesWithMetadata(ctx, message, result);
      if (materializationFailures.length > 0) {
        console.error(
          "Failed to materialize persisted assistant streams",
          materializationFailures,
        );
        await markPendingMessageFailed(
          ctx,
          message,
          result.status === "failed" ? result.error : STREAM_RECOVERY_FAILURE,
        );
        return;
      }
      if (messages.length > 0) {
        // Nested so an oversized recovered message rolls back on its own and
        // the pending message is marked failed instead of stuck.
        try {
          await ctx.runMutation(api.messages.addMessages, {
            messages,
            threadId: message.threadId,
            agentName: message.agentName,
            failPendingSteps: false,
            pendingMessageId: messageId,
            userId: message.userId,
            embeddings: undefined,
          });
        } catch (error) {
          console.error("Failed to persist recovered assistant streams", error);
          await markPendingMessageFailed(
            ctx,
            message,
            result.status === "failed" ? result.error : STREAM_RECOVERY_FAILURE,
          );
          return;
        }
        await releaseStreamFileOwnershipByIds(ctx, streamsToRelease);
        return;
      }
    }
    if (result.status === "failed") {
      await markPendingMessageFailed(ctx, message, result.error);
    } else {
      await ctx.db.patch("messages", messageId, { status: "success" });
    }
  },
});

export const updateMessage = mutation({
  args: {
    messageId: v.id("messages"),
    patch: v.object(
      partial(
        pick(schema.tables.messages.validator.fields, [
          "message",
          "fileIds",
          "status",
          "error",
          "model",
          "provider",
          "providerOptions",
          "finishReason",
        ]),
      ),
    ),
  },
  returns: vMessageDoc,
  handler: async (ctx, args) => {
    const message = await ctx.db.get("messages", args.messageId);
    assert(message, `Message ${args.messageId} not found`);

    if (args.patch.fileIds) {
      await changeRefcount(ctx, message.fileIds ?? [], args.patch.fileIds);
    }

    const patch: Partial<Doc<"messages">> = { ...args.patch };

    if (args.patch.message !== undefined) {
      patch.message = args.patch.message;
      patch.tool = isTool(args.patch.message);
      patch.text = extractText(args.patch.message);
    }

    if (args.patch.status === "failed") {
      if (message.embeddingId) {
        const { tableName } = getVectorIdInfo(ctx, message.embeddingId);
        await ctx.db.delete(tableName, message.embeddingId);
      }
      patch.embeddingId = undefined;
    }

    await ctx.db.patch("messages", args.messageId, patch);
    return publicMessage((await ctx.db.get("messages", args.messageId))!);
  },
});

export const respondToToolCallApprovals = mutation({
  args: {
    threadId: v.id("threads"),
    agentName: v.optional(v.string()),
    decisions: v.array(
      v.object({
        approvalId: v.string(),
        approved: v.boolean(),
        reason: v.optional(v.string()),
      }),
    ),
  },
  returns: v.object({ messageId: v.id("messages") }),
  handler: async (ctx, args) => {
    const page = await listMessagesByThreadIdHandler(ctx, {
      threadId: args.threadId,
      order: "desc",
      paginationOpts: { cursor: null, numItems: APPROVAL_LOOKUP_MESSAGES },
    });
    const plan = planToolCallApprovals(
      page.page,
      args.decisions,
      args.threadId,
    );
    const saved = await addMessagesHandler(ctx, {
      threadId: args.threadId,
      agentName: args.agentName,
      promptMessageId: plan.requestMessageId as Id<"messages">,
      failPendingSteps: false,
      messages: [{ message: plan.message }],
    });
    return { messageId: saved.messages[0]._id as Id<"messages"> };
  },
});

const cloneMessageArgs = {
  sourceThreadId: v.id("threads"),
  targetThreadId: v.id("threads"),
  // defaults to false, so searching for a message by userId will not find
  // these copies
  copyUserIdForVectorSearch: v.optional(v.boolean()),
  // defaults to false, so tool calls & responses will be copied
  excludeToolMessages: v.optional(v.boolean()),
  // defaults to copying all messages, but you could just copy success messages.
  statuses: v.optional(v.array(vMessageStatus)),
  // stop at this message id
  upToAndIncludingMessageId: v.optional(v.id("messages")),
  // defaults to 0. the messages will be inserted starting at this order.
  insertAtOrder: v.optional(v.number()),
};
export const cloneMessageBatch = internalMutation({
  args: {
    ...cloneMessageArgs,
    paginationOpts: paginationOptsValidator,
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    numCopied: number;
    continueCursor: string;
    isDone: boolean;
  }> => {
    const orderOffset = args.insertAtOrder ?? 0;
    const result = await listMessagesByThreadIdHandler(ctx, {
      threadId: args.sourceThreadId,
      excludeToolMessages: args.excludeToolMessages,
      order: "desc",
      paginationOpts: args.paginationOpts,
      statuses: args.statuses,
      upToAndIncludingMessageId: args.upToAndIncludingMessageId,
    });

    const existing =
      result.page.length === 0
        ? []
        : await mergedStream(
            [true, false].flatMap((tool) =>
              messageStatuses.map((status) =>
                stream(ctx.db, schema)
                  .query("messages")
                  .withIndex("threadId_status_tool_order_stepOrder", (q) =>
                    q
                      .eq("threadId", args.targetThreadId)
                      .eq("status", status)
                      .eq("tool", tool)
                      .gte("order", result.page[0].order)
                      .lte("order", result.page[result.page.length - 1].order),
                  ),
              ),
            ),
            ["order", "stepOrder"],
          ).collect();

    await Promise.all(
      result.page
        .filter(
          (m) =>
            !existing.some(
              (e) => e.order === m.order && e.stepOrder === m.stepOrder,
            ),
        )
        .map(async (m) => {
          // update file refs
          if (m.fileIds) {
            await changeRefcount(ctx, [], m.fileIds);
          }
          let embeddingId: VectorTableId | undefined = undefined;
          if (m.embeddingId) {
            const { tableName } = getVectorIdInfo(ctx, m.embeddingId);
            const vector = await ctx.db.get(tableName, m.embeddingId);
            assert(vector, `Vector ${m.embeddingId} not found`);
            const dimension = vector.vector.length;
            validateVectorDimension(dimension);
            embeddingId = await insertVector(ctx, dimension, {
              ...pick(vector, ["model", "table", "vector"]),
              userId: args.copyUserIdForVectorSearch
                ? vector.userId
                : undefined,
              threadId: args.targetThreadId,
            });
          }
          // parentMessageId would point into the source thread. Nothing
          // reads it yet, and remapping needs the parent copied first, which
          // descending batches do not guarantee, so the copy carries none.
          await ctx.db.insert("messages", {
            ...omit(m, [
              "_id",
              "_creationTime",
              "threadId",
              "order",
              "embeddingId",
              "parentMessageId",
            ]),
            embeddingId,
            threadId: args.targetThreadId,
            order: orderOffset + m.order,
          });
        }),
    );
    return {
      numCopied: result.page.length,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

export const cloneThread = action({
  args: {
    ...cloneMessageArgs,
    batchSize: v.optional(v.number()),
    // how many messages to copy
    limit: v.optional(v.number()),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const { batchSize, limit, ...batchArgs } = args;
    let cursor: string | null = null;
    let copiedSoFar = 0;
    while (copiedSoFar < (limit ?? Infinity)) {
      const numToCopy = Math.min(
        batchSize ?? DEFAULT_RECENT_MESSAGES,
        (limit ?? Infinity) - copiedSoFar,
      );
      const result: {
        numCopied: number;
        continueCursor: string;
        isDone: boolean;
      } = await ctx.runMutation(internal.messages.cloneMessageBatch, {
        ...batchArgs,
        paginationOpts: {
          cursor,
          numItems: numToCopy,
        },
      });
      copiedSoFar += result.numCopied;
      cursor = result.continueCursor;
      if (result.isDone) {
        break;
      }
    }
    return copiedSoFar;
  },
});

export const listMessagesByThreadIdArgs = {
  threadId: v.id("threads"),
  excludeToolMessages: v.optional(v.boolean()),
  /** What order to sort the messages in. To get the latest, use "desc". */
  order: v.union(v.literal("asc"), v.literal("desc")),
  paginationOpts: v.optional(paginationOptsValidator),
  statuses: v.optional(v.array(vMessageStatus)),
  upToAndIncludingMessageId: v.optional(v.id("messages")),
};
export const listMessagesByThreadId = query({
  args: listMessagesByThreadIdArgs,
  handler: async (ctx, args) => {
    const messages = await listMessagesByThreadIdHandler(ctx, args, {
      keepContinuedOrderTools: true,
    });
    return { ...messages, page: messages.page.map(publicMessage) };
  },
  returns: vPaginationResult(vMessageDoc),
});

async function listMessagesByThreadIdHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof listMessagesByThreadIdArgs>,
  { keepContinuedOrderTools = false } = {},
) {
  const statuses = args.statuses ?? vMessageStatus.members.map((m) => m.value);
  const last =
    args.upToAndIncludingMessageId &&
    (await ctx.db.get("messages", args.upToAndIncludingMessageId));
  assert(
    !last || last.threadId === args.threadId,
    "upToAndIncludingMessageId must be a message in the thread",
  );
  const toolOptions = args.excludeToolMessages ? [false] : [true, false];
  const order = args.order ?? "desc";
  const streams = toolOptions.flatMap((tool) =>
    statuses.map((status) =>
      stream(ctx.db, schema)
        .query("messages")
        .withIndex("threadId_status_tool_order_stepOrder", (q) => {
          const qq = q
            .eq("threadId", args.threadId)
            .eq("status", status)
            .eq("tool", tool);
          if (last) {
            return qq.lte("order", last.order);
          }
          return qq;
        })
        .order(order),
    ),
  );
  // Excluding tool messages trims earlier orders. The order being continued
  // keeps them, or an approval loses its call and decision (#409). Cloning
  // reuses this handler and wants strict exclusion.
  if (args.excludeToolMessages && last && keepContinuedOrderTools) {
    streams.push(
      ...statuses.map((status) =>
        stream(ctx.db, schema)
          .query("messages")
          .withIndex("threadId_status_tool_order_stepOrder", (q) =>
            q
              .eq("threadId", args.threadId)
              .eq("status", status)
              .eq("tool", true)
              .eq("order", last.order),
          )
          .order(order),
      ),
    );
  }
  const messages = await mergedStream(streams, ["order", "stepOrder"]).paginate(
    args.paginationOpts ?? {
      numItems: DEFAULT_RECENT_MESSAGES,
      cursor: null,
    },
  );
  if (messages.page.length === 0) {
    messages.isDone = true;
  }
  return messages;
}

export const getMessagesByIds = query({
  args: { messageIds: v.array(v.id("messages")) },
  handler: async (ctx, args) => {
    return (
      await Promise.all(args.messageIds.map((id) => ctx.db.get("messages", id)))
    ).map((m) => (m ? publicMessage(m) : null));
  },
  returns: v.array(v.union(v.null(), vMessageDoc)),
});

export const searchMessages = action({
  args: {
    threadId: v.optional(v.id("threads")),
    searchAllMessagesForUserId: v.optional(v.string()),
    targetMessageId: v.optional(v.id("messages")),
    embedding: v.optional(v.array(v.number())),
    embeddingModel: v.optional(v.string()),
    text: v.optional(v.string()),
    textSearch: v.optional(v.boolean()),
    vectorSearch: v.optional(v.boolean()),
    limit: v.number(),
    vectorScoreThreshold: v.optional(v.number()),
    messageRange: v.optional(
      v.object({ before: v.number(), after: v.number() }),
    ),
  },
  returns: v.array(vMessageDoc),
  handler: async (ctx, args): Promise<MessageDoc[]> => {
    assert(
      args.searchAllMessagesForUserId || args.threadId,
      "Specify userId or threadId",
    );
    const limit = args.limit;
    let textSearchMessages: MessageDoc[] | undefined;
    if (args.textSearch) {
      textSearchMessages = await ctx.runQuery(api.messages.textSearch, {
        searchAllMessagesForUserId: args.searchAllMessagesForUserId,
        threadId: args.threadId,
        targetMessageId: args.targetMessageId,
        text: args.text,
        limit,
      });
    }
    if (args.vectorSearch) {
      let embedding = args.embedding;
      let model = args.embeddingModel;
      if (!embedding) {
        if (args.targetMessageId) {
          const target = await ctx.runQuery(
            api.messages.getMessageSearchFields,
            {
              messageId: args.targetMessageId,
            },
          );
          assert(target, "Target message embedding not found.");
          embedding = target.embedding;
          model = target.embeddingModel;
        }
      }
      assert(embedding && model, "Embedding missing");
      const dimension = embedding.length;
      validateVectorDimension(dimension);
      const vectors = (
        await searchVectors(ctx, embedding, {
          dimension,
          model,
          table: "messages",
          searchAllMessagesForUserId: args.searchAllMessagesForUserId,
          threadId: args.threadId,
          limit,
        })
      ).filter((v) => v._score > (args.vectorScoreThreshold ?? 0));
      // Reciprocal rank fusion
      const k = 10;
      const textEmbeddingIds = textSearchMessages?.map((m) => m.embeddingId);
      const vectorScores = vectors
        .map((v, i) => ({
          id: v._id,
          score:
            1 / (i + k) +
            1 / ((textEmbeddingIds?.indexOf(v._id) ?? Infinity) + k),
        }))
        .sort((a, b) => b.score - a.score);
      const embeddingIds = vectorScores.slice(0, limit).map((v) => v.id);
      const messages: MessageDoc[] = await ctx.runQuery(
        internal.messages._fetchSearchMessages,
        {
          searchAllMessagesForUserId: args.searchAllMessagesForUserId,
          threadId: args.threadId,
          embeddingIds,
          textSearchMessages: textSearchMessages?.filter(
            (m) => !embeddingIds.includes(m.embeddingId! as VectorTableId),
          ),
          messageRange: args.messageRange ?? DEFAULT_MESSAGE_RANGE,
          beforeMessageId: args.targetMessageId,
          limit,
        },
      );
      return messages;
    }
    return textSearchMessages?.flat() ?? [];
  },
});

export const _fetchSearchMessages = internalQuery({
  args: {
    threadId: v.optional(v.id("threads")),
    embeddingIds: v.array(vVectorId),
    searchAllMessagesForUserId: v.optional(v.string()),
    textSearchMessages: v.optional(v.array(vMessageDoc)),
    messageRange: v.object({ before: v.number(), after: v.number() }),
    beforeMessageId: v.optional(v.id("messages")),
    limit: v.number(),
  },
  returns: v.array(vMessageDoc),
  handler: async (ctx, args): Promise<MessageDoc[]> => {
    const beforeMessage =
      args.beforeMessageId &&
      (await ctx.db.get("messages", args.beforeMessageId));
    const { searchAllMessagesForUserId, threadId } = args;
    assert(
      searchAllMessagesForUserId || threadId,
      "Specify searchAllMessagesForUserId or threadId to search",
    );
    let messages: MessageDoc[] = (
      await Promise.all(
        args.embeddingIds.map((embeddingId) =>
          ctx.db
            .query("messages")
            .withIndex("embeddingId_threadId", (q) =>
              searchAllMessagesForUserId
                ? q.eq("embeddingId", embeddingId)
                : q.eq("embeddingId", embeddingId).eq("threadId", threadId!),
            )
            // eslint-disable-next-line @convex-dev/no-filter-in-query -- We do not expect many messages with the same embeddingId for different users / threads
            .filter((q) =>
              q.and(
                q.eq(q.field("status"), "success"),
                searchAllMessagesForUserId
                  ? q.eq(q.field("userId"), searchAllMessagesForUserId)
                  : q.eq(q.field("threadId"), threadId),
              ),
            )
            .first(),
        ),
      )
    )
      .filter((m): m is Doc<"messages"> => {
        if (m === undefined || m === null || m.tool) return false;
        if (!beforeMessage) return true;
        // The order filter is only meaningful within the same thread.
        // Messages from other threads have independent order sequences.
        if (m.threadId !== beforeMessage.threadId) return true;
        return (
          m.order < beforeMessage.order ||
          (m.order === beforeMessage.order &&
            m.stepOrder < beforeMessage.stepOrder)
        );
      })
      .map(publicMessage);
    messages.push(...(args.textSearchMessages ?? []));
    // TODO: prioritize more recent messages
    messages = sorted(messages);
    messages = messages.slice(0, args.limit);
    // Fetch the surrounding messages
    if (!threadId) {
      return messages;
    }
    const included: Record<string, Set<number>> = {};
    for (const m of messages) {
      const searchId = m.threadId ?? m.userId!;
      if (!included[searchId]) {
        included[searchId] = new Set();
      }
      included[searchId].add(m.order!);
    }
    const ranges: Record<string, Doc<"messages">[]> = {};
    const { before, after } = args.messageRange;
    for (const m of messages) {
      const searchId = m.threadId ?? m.userId!;
      const order = m.order!;
      let earliest = order - before;
      let latest = order + after;
      for (; earliest <= latest; earliest++) {
        if (!included[searchId].has(earliest)) {
          break;
        }
      }
      for (; latest >= earliest; latest--) {
        if (!included[searchId].has(latest)) {
          break;
        }
      }
      for (let i = earliest; i <= latest; i++) {
        included[searchId].add(i);
      }
      if (earliest !== latest) {
        const surrounding = await ctx.db
          .query("messages")
          .withIndex("threadId_status_tool_order_stepOrder", (q) =>
            q
              .eq("threadId", m.threadId as Id<"threads">)
              .eq("status", "success")
              .eq("tool", false)
              .gte("order", earliest)
              .lte("order", latest),
          )
          .collect();
        if (!ranges[searchId]) {
          ranges[searchId] = [];
        }
        ranges[searchId].push(...surrounding);
      }
    }
    for (const r of Object.values(ranges).flat()) {
      if (!messages.some((m) => m._id === r._id)) {
        messages.push(publicMessage(r));
      }
    }
    return sorted(messages);
  },
});

// returns ranges of messages in order of text search relevance,
// excluding duplicates in later ranges.
export const textSearch = query({
  args: {
    threadId: v.optional(v.id("threads")),
    searchAllMessagesForUserId: v.optional(v.string()),
    text: v.optional(v.string()),
    targetMessageId: v.optional(v.id("messages")),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    assert(
      args.searchAllMessagesForUserId || args.threadId,
      "Specify userId or threadId",
    );
    const targetMessage =
      args.targetMessageId &&
      (await ctx.db.get("messages", args.targetMessageId));
    const text = args.text || targetMessage?.text;
    if (!text) {
      console.warn("No text to search", targetMessage, args.text);
      return [];
    }
    // When searching across threads (searchAllMessagesForUserId), the
    // targetMessage's order is only meaningful within its own thread, so we
    // can't apply it as a database-level filter. We still apply it post-fetch
    // for same-thread results below.
    const restrictOrderInDb = !args.searchAllMessagesForUserId && targetMessage;
    const messages = await ctx.db
      .query("messages")
      .withSearchIndex("text_search", (q) =>
        args.searchAllMessagesForUserId
          ? q.search("text", text).eq("userId", args.searchAllMessagesForUserId)
          : q.search("text", text).eq("threadId", args.threadId!),
      )
      // Just in case tool messages slip through
      // eslint-disable-next-line @convex-dev/no-filter-in-query -- we can't do this in the search index, but text search ideally isn't for really old orders
      .filter((q) => {
        const qq = q.eq(q.field("tool"), false);
        if (restrictOrderInDb) {
          return q.and(qq, q.lte(q.field("order"), targetMessage.order));
        }
        return qq;
      })
      .take(args.limit);
    return messages
      .filter((m) => {
        if (!targetMessage) return true;
        // Order is only meaningful within the same thread; cross-thread
        // results have independent order sequences and should pass through.
        if (m.threadId !== targetMessage.threadId) return true;
        return (
          m.order < targetMessage.order ||
          (m.order === targetMessage.order &&
            m.stepOrder < targetMessage.stepOrder)
        );
      })
      .map(publicMessage);
  },
  returns: v.array(vMessageDoc),
});

export const getMessageSearchFields = query({
  args: {
    messageId: v.id("messages"),
  },
  returns: v.object({
    text: v.optional(v.string()),
    embedding: v.optional(v.array(v.number())),
    embeddingModel: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    text?: string | undefined;
    embedding?: number[] | undefined;
    embeddingModel?: string | undefined;
  }> => {
    const message = await ctx.db.get("messages", args.messageId);
    const text = message?.text;
    let embedding = undefined;
    let embeddingModel = undefined;
    if (message?.embeddingId) {
      const { tableName } = getVectorIdInfo(ctx, message.embeddingId);
      const target = await ctx.db.get(tableName, message.embeddingId);
      embedding = target?.vector;
      embeddingModel = target?.model;
    }
    return {
      text,
      embedding,
      embeddingModel,
    };
  },
});
