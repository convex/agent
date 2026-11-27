import { assert, omit, pick } from "convex-helpers";
import { mergedStream, stream } from "convex-helpers/server/stream";
import {
  paginationOptsValidator,
  type FunctionHandle,
  type WithoutSystemFields,
} from "convex/server";
import { ConvexError, type ObjectType, v as baseV } from "convex/values";
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
  vProviderOptions,
  type MessageDoc,
  type OnSaveMessagesArgs,
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
import { leaveOutText, withText } from "../messageText.js";
import {
  getStreamingMessagesWithMetadata,
  finishHandler,
  releaseStreamFileOwnershipByIds,
  abortStreamsAtOrder,
  abortById,
  createStream,
  endStoppedStream,
} from "./streams.js";
import { partial } from "convex-helpers/validators";
import {
  APPROVAL_LOOKUP_MESSAGES,
  planToolCallResponses,
} from "../approvals.js";
import {
  adoptOpenRow,
  authorizeEnding,
  authorizeRow,
  endStopped,
  endStoppedInThread,
  stoppedOpen,
  endTurnsForDeleted,
  failPlainReplies,
  planResponse,
  planSave,
  resolve,
  retryTurn,
  type SaveTurn,
  settle,
  stopTurns,
} from "./turns.js";

export const vOnSaveMessages = v.optional(v.string());

type SavedMessage = {
  kind: OnSaveMessagesArgs["messages"][number]["kind"];
  doc: Pick<Doc<"messages">, "order" | "stepOrder" | "status"> & {
    _id: string;
    threadId: string;
  };
};

// One scheduled function per thread, so each thread's hook runs and fails in
// its own transaction. Only ids and positions are passed: whole docs could
// exceed the scheduler's argument limit on a large delete.
export async function reportSavedMessages(
  ctx: MutationCtx,
  onSaveMessages: string | undefined,
  saved: SavedMessage[],
) {
  if (!onSaveMessages) return;
  const byThread = new Map<string, OnSaveMessagesArgs["messages"]>();
  for (const { kind, doc } of saved) {
    const messages = byThread.get(doc.threadId) ?? [];
    messages.push({
      kind,
      messageId: doc._id,
      order: doc.order,
      stepOrder: doc.stepOrder,
      status: doc.status,
    });
    byThread.set(doc.threadId, messages);
  }
  for (const [threadId, messages] of byThread) {
    await ctx.scheduler.runAfter(
      0,
      onSaveMessages as FunctionHandle<"mutation", OnSaveMessagesArgs>,
      { threadId, messages },
    );
  }
}

function publicMessage(message: Doc<"messages">): MessageDoc {
  const {
    parentMessageId: _parentMessageId,
    stepId: _stepId,
    files: _files,
    turnId: _turnId,
    jobId: _jobId,
    streamId: _streamId,
    ...doc
  } = withText(message);
  return withDerivedReasoning(doc);
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
  // Only a durable turn's rows have tool records.
  if (messageDoc.turnId) await deleteToolRecords(ctx, messageDoc._id);
}

async function deleteToolRecords(ctx: MutationCtx, messageId: Id<"messages">) {
  for (const step of await ctx.db
    .query("toolSteps")
    .withIndex("messageId", (q) => q.eq("messageId", messageId))
    .collect()) {
    await ctx.db.delete("toolSteps", step._id);
  }
  for (const result of await ctx.db
    .query("toolResults")
    .withIndex("messageId_toolCallId", (q) => q.eq("messageId", messageId))
    .collect()) {
    await ctx.db.delete("toolResults", result._id);
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
      plainOnly: true,
    });
  }
}

/** Deleting a turn's prompt, request or open row ends the turn; a plain stream at the order aborts. */
export async function endDeleted(
  ctx: MutationCtx,
  deleted: (Doc<"messages"> | null)[],
) {
  if (deleted.some((m) => m?.turnId)) await endTurnsForDeleted(ctx, deleted);
  await failPlainReplies(
    ctx,
    deleted.filter((m) => m !== null),
  );
  await abortStreamsForDeleted(ctx, deleted);
}

async function closeLinkedStream(
  ctx: MutationCtx,
  row: Doc<"messages">,
  finished: boolean,
) {
  if (!row.streamId) return;
  const stream = await ctx.db.get("streamingMessages", row.streamId);
  if (stream?.state.kind !== "streaming") return;
  if (finished) await finishHandler(ctx, { streamId: stream._id });
  else await abortById(ctx, { streamId: stream._id, reason: "Ended" });
}

export const deleteByIds = mutation({
  args: {
    messageIds: v.array(v.id("messages")),
    onSaveMessages: vOnSaveMessages,
  },
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
    await endDeleted(ctx, deleted);
    const found = deleted.filter((m) => m !== null);
    await reportSavedMessages(
      ctx,
      args.onSaveMessages,
      found.map((doc) => ({ kind: "delete", doc })),
    );
    return found.map((m) => m._id);
  },
});

export const messageStatuses = vMessageDoc.fields.status.members.map(
  (m) => m.value,
);

const STREAM_RECOVERY_FAILURE =
  "Failed to recover persisted assistant stream output";

/** Writes an existing row; one that leaves pending keeps no job copy, as only an open row is leased. */
async function writeMessage(
  ctx: MutationCtx,
  messageId: Id<"messages">,
  patch: Partial<Doc<"messages">>,
) {
  const closes = patch.status !== undefined && patch.status !== "pending";
  await ctx.db.patch(
    "messages",
    messageId,
    closes ? { ...patch, jobId: undefined } : patch,
  );
}

async function markPendingMessageFailed(
  ctx: MutationCtx,
  message: Doc<"messages">,
  error: string,
  onSaveMessages: string | undefined,
) {
  if (message.embeddingId) {
    const { tableName } = getVectorIdInfo(ctx, message.embeddingId);
    await ctx.db.delete(tableName, message.embeddingId);
  }
  const patch = { status: "failed" as const, error, embeddingId: undefined };
  await writeMessage(ctx, message._id, patch);
  await reportSavedMessages(ctx, onSaveMessages, [
    { kind: "update", doc: { ...message, ...patch } },
  ]);
}

export const deleteByOrder = mutation({
  args: {
    threadId: v.id("threads"),
    startOrder: v.number(),
    startStepOrder: v.optional(v.number()),
    endOrder: v.number(),
    endStepOrder: v.optional(v.number()),
    onSaveMessages: vOnSaveMessages,
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
    await endDeleted(ctx, messages);
    await reportSavedMessages(
      ctx,
      args.onSaveMessages,
      messages.map((doc) => ({ kind: "delete", doc })),
    );
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
  // A pending message to update. If the pending message failed, abort. If it
  // already succeeded, throw.
  pendingMessageId: v.optional(v.id("messages")),
  // if set to true, these messages will not show up in text or vector search
  // results for the userId
  hideFromUserIdSearch: v.optional(v.boolean()),
  // If provided, finish this stream atomically with the message save.
  // This prevents UI flickering from separate mutations (issue #181).
  // Failed messages abort it instead.
  finishStreamId: v.optional(v.id("streamingMessages")),
  onSaveMessages: vOnSaveMessages,
  // Starts a stream with the last message, which must be pending.
  createStream: v.optional(
    v.object(
      pick(schema.tables.streamingMessages.validator.fields, [
        "agentName",
        "format",
        "model",
        "provider",
        "providerOptions",
      ]),
    ),
  ),
  // A handle to an action taking { threadId, promptMessageId }, scheduled to
  // answer the last message: the save starts a durable turn.
  generate: v.optional(v.string()),
};
export const vJobId = baseV.id("_scheduled_functions");
export const addMessages = mutation({
  args: addMessagesArgs,
  handler: (ctx, args) => addMessagesHandler(ctx, args),
  returns: v.object({
    messages: v.array(vMessageDoc),
    streamId: v.optional(v.id("streamingMessages")),
    // The job a save with `generate` scheduled.
    jobId: v.optional(vJobId),
    // Only for the turn's own job, when this save belongs to its turn.
    turn: v.optional(
      v.object({ promptMessageId: v.id("messages"), jobId: vJobId }),
    ),
  }),
});

export const retryGeneration = mutation({
  args: {
    threadId: v.id("threads"),
    promptMessageId: v.optional(v.id("messages")),
    maxRetries: v.optional(v.number()),
  },
  returns: v.union(v.null(), vJobId),
  handler: async (ctx, args) =>
    (await retryTurn(ctx, args)) as Id<"_scheduled_functions"> | null,
});

export const abortGeneration = mutation({
  args: {
    threadId: v.id("threads"),
    promptMessageId: v.optional(v.id("messages")),
    reason: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: (ctx, { reason, ...args }) => stopTurns(ctx, args, reason),
});

export const _recover = internalMutation({
  args: { ...addMessagesArgs, turnId: v.id("turns") },
  returns: v.object({ messages: v.array(vMessageDoc) }),
  handler: async (ctx, { turnId, ...args }) => {
    const { messages } = await addMessagesHandler(ctx, args, undefined, {
      stamp: () => ({ turnId }),
    });
    return { messages };
  },
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
  // For a caller that already read the prompt and its order's last step.
  prompt?: { message: Doc<"messages">; lastStepOrder: number },
  turnPlan?: SaveTurn,
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
    onSaveMessages,
    createStream: streamToCreate,
    generate,
    ...rest
  } = args;
  const promptMessage =
    prompt?.message ??
    (promptMessageId && (await resolve(ctx, threadId, promptMessageId)));
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
  assert(
    !streamToCreate ||
      (messages.at(-1)?.status === "pending" &&
        !(pendingMessageId && messages.length === 1)),
    "createStream needs a new pending message last",
  );
  const plan =
    turnPlan ??
    (await planSave(ctx, {
      threadId,
      generate,
      promptMessage: promptMessage || null,
      pendingMessageId,
      order: requestedOrder,
      messages,
    }));
  if (plan.stopped) return { messages: [publicMessage(plan.pending!)] };
  if (plan.userId !== undefined && !args.userId) userId = plan.userId;
  if (messages.some((m) => m.message.role === "user")) {
    await endStoppedInThread(ctx, threadId);
  }
  if (plan.adopt) {
    const adopted = await adoptOpenRow(
      ctx,
      plan.adopt,
      streamToCreate &&
        ((stamp, row) =>
          createStream(ctx, {
            ...streamToCreate,
            threadId,
            userId: row.userId,
            order: row.order,
            stepOrder: row.stepOrder,
            ...stamp,
          })),
    );
    return {
      messages: [publicMessage(adopted.row)],
      ...(adopted.streamId ? { streamId: adopted.streamId } : {}),
      turn: adopted.turn as {
        promptMessageId: Id<"messages">;
        jobId: Id<"_scheduled_functions">;
      },
    };
  }
  const saved: SavedMessage[] = [];
  if (failPendingSteps) {
    assert(args.threadId, "threadId is required to fail pending steps");
    const pendingMessages = await ctx.db
      .query("messages")
      .withIndex("threadId_status_tool_order_stepOrder", (q) =>
        q.eq("threadId", threadId).eq("status", "pending"),
      )
      .order("desc")
      .take(100);
    const atPrompt = pendingMessages
      .filter((m) => !promptMessage || m.order === promptMessage.order)
      .filter((m) => !pendingMessageId || m._id !== pendingMessageId);
    for (const m of atPrompt) if (stoppedOpen(m)) await endStopped(ctx, m);
    // A row with a job copy is a live turn's, which only its turn ends.
    const restarted = atPrompt.filter((m) => m.jobId === undefined);
    const patch = {
      status: "failed" as const,
      error: "Restarting",
      embeddingId: undefined,
    };
    await Promise.all(
      restarted.map(async (m) => {
        if (m.embeddingId) {
          const { tableName } = getVectorIdInfo(ctx, m.embeddingId);
          await ctx.db.delete(tableName, m.embeddingId);
        }
        await writeMessage(ctx, m._id, patch);
      }),
    );
    saved.push(
      ...restarted.map((m) => ({
        kind: "update" as const,
        doc: { ...m, ...patch },
      })),
    );
  }
  let order, stepOrder;
  let pendingMessage: Doc<"messages"> | null = plan.pending ?? null;
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
      await reportSavedMessages(ctx, onSaveMessages, saved);
      return { messages: [] };
    }
    assert(promptMessage, `Parent message ${promptMessageId} not found`);
    if (promptMessage.status === "failed") {
      fail = true;
      error = promptMessage.error ?? error ?? "The prompt message failed";
    }
    order = promptMessage.order;
    // A pending row filled at its prompt is read already: only what follows it is read.
    const after =
      plan.pending?.order === order ? plan.pending.stepOrder : undefined;
    // Defend against there being existing messages with this parent.
    stepOrder =
      prompt?.lastStepOrder ??
      (await getMaxMessage(ctx, threadId, order, after))?.stepOrder ??
      after ??
      promptMessage.stepOrder;
  } else if (pendingMessageId) {
    // What fills a pending message stays in its turn.
    pendingMessage =
      plan.pending !== undefined
        ? plan.pending
        : await ctx.db.get("messages", pendingMessageId);
    assert(pendingMessage, `Pending msg ${pendingMessageId} not found`);
    order = pendingMessage.order;
    stepOrder =
      (await getMaxMessage(ctx, threadId, order, pendingMessage.stepOrder))
        ?.stepOrder ?? pendingMessage.stepOrder;
  } else {
    const maxMessage = await getMaxMessage(ctx, threadId);
    order = maxMessage?.order ?? -1;
    stepOrder = maxMessage?.stepOrder ?? -1;
  }
  const toReturn: Doc<"messages">[] = [];
  let streamId: Id<"streamingMessages"> | undefined;
  if (embeddings) {
    assert(
      embeddings.vectors.length === messages.length,
      "embeddings.vectors.length must match messages.length",
    );
  }
  // A stopped job's ending keeps its steps, as the AI SDK keeps an aborted
  // one, and opens no next step.
  let saving = messages.length;
  while (plan.ending && messages[saving - 1]?.status === "pending") saving--;
  for (let i = 0; i < saving; i++) {
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
    const text = hideFromUserIdSearch
      ? undefined
      : extractText(message.message);
    const messageDoc = {
      ...rest,
      ...message,
      embeddingId,
      parentMessageId: promptMessageId,
      userId,
      tool: isTool(message.message),
      text,
      ...leaveOutText(message.message, text),
      status: fail ? "failed" : (message.status ?? "success"),
      error: fail ? error : message.error,
    } satisfies Omit<
      WithoutSystemFields<Doc<"messages">>,
      "order" | "stepOrder"
    >;
    // If there is a pending message, we replace that one with the first message
    // and subsequent ones will follow the regular order/subOrder advancement.
    if (i === 0 && pendingMessageId) {
      pendingMessage ??=
        plan.pending === undefined
          ? await ctx.db.get("messages", pendingMessageId)
          : null;
      assert(pendingMessage, `Pending msg ${pendingMessageId} not found`);
      if (pendingMessage.status === "success") {
        throw new ConvexError(
          `Message ${pendingMessageId} can't be filled: its status is "success", not "pending"`,
        );
      }
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
        streamId: pendingMessage.streamId,
        abort: pendingMessage.abort,
        ...plan.stamp?.(
          pendingMessage.order,
          messageDoc.status,
          pendingMessage,
        ),
      });
      const replaced = (await ctx.db.get("messages", pendingMessage._id))!;
      toReturn.push(replaced);
      saved.push({ kind: "update", doc: replaced });
      continue;
    }
    if ((startsAtNextOrder || explicitOrder !== undefined) && i === 0) {
      stepOrder = incrementMessagePosition(stepOrder, "stepOrder");
    } else if (message.message.role === "user") {
      if (
        (explicitOrder !== undefined && order === explicitOrder) ||
        (promptMessage && promptMessage.order === order) ||
        (!promptMessageId && pendingMessage?.order === order)
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
    if (
      streamToCreate &&
      !plan.ending &&
      i === messages.length - 1 &&
      messageDoc.status === "pending"
    ) {
      streamId = await createStream(ctx, {
        ...streamToCreate,
        threadId,
        userId,
        order,
        stepOrder,
        ...plan.streamStamp,
      });
    }
    const messageId = await ctx.db.insert("messages", {
      ...messageDoc,
      order,
      stepOrder,
      ...(plan.unlinked
        ? {}
        : {
            streamId:
              streamId ??
              (i === messages.length - 1 && messageDoc.status === "pending"
                ? plan.carry
                : undefined),
          }),
      ...plan.stamp?.(order, messageDoc.status),
    });
    if (message.fileIds) {
      await changeRefcount(ctx, [], message.fileIds);
    }
    // TODO: delete the associated stream data for the order/stepOrder
    const inserted = (await ctx.db.get("messages", messageId))!;
    toReturn.push(inserted);
    saved.push({ kind: "insert", doc: inserted });
  }
  // Atomically finish the stream if requested, preventing UI flickering
  // from separate mutations for message save and stream finish (issue #181).
  const failed = toReturn.find((m) => m.status === "failed");
  if (finishStreamId && !plan.ending && failed) {
    await abortById(ctx, {
      streamId: finishStreamId,
      reason: failed.error ?? "The generation failed",
      lease: true,
    });
  } else if (finishStreamId && !plan.ending) {
    await finishHandler(ctx, {
      streamId: finishStreamId,
      lease: true,
    });
    await releaseStreamFileOwnershipByIds(ctx, [finishStreamId]);
  }
  const turn = plan.after
    ? await plan.after(toReturn, streamId, finishStreamId)
    : {};
  await reportSavedMessages(ctx, onSaveMessages, saved);
  return {
    messages: toReturn.map(publicMessage),
    ...(streamId ? { streamId } : {}),
    ...(turn as {
      jobId?: Id<"_scheduled_functions">;
      turn?: {
        promptMessageId: Id<"messages">;
        jobId: Id<"_scheduled_functions">;
      };
    }),
  };
}

// exported for tests
export async function getMaxMessage(
  ctx: QueryCtx,
  threadId: Id<"threads">,
  order?: number,
  afterStepOrder?: number,
) {
  return orderedMessagesStream(ctx, {
    threadId,
    sortOrder: "desc",
    startOrder: order,
    startOrderBound: "eq",
    afterStepOrder,
  }).first();
}

function orderedMessagesStream(
  ctx: QueryCtx,
  args: {
    threadId: Id<"threads">;
    sortOrder: "asc" | "desc";
    startOrder?: number;
    startOrderBound?: "gte" | "eq";
    /** With an `eq` bound, only the messages after this step. */
    afterStepOrder?: number;
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
              }
              const at = qq.eq("order", args.startOrder);
              return args.afterStepOrder === undefined
                ? at
                : at.gt("stepOrder", args.afterStepOrder);
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
    onSaveMessages: vOnSaveMessages,
  },
  returns: v.null(),
  handler: async (ctx, { messageId, result, onSaveMessages }) => {
    const stored = await ctx.db.get("messages", messageId);
    assert(stored, `Message ${messageId} not found`);
    const write = await authorizeEnding(ctx, stored);
    if (!stored.turnId) {
      return finalizePending(ctx, stored, result, onSaveMessages);
    }
    if (write.as === "stopped") return null;
    if (write.as === "ending") {
      // A stopped reply ends as stopped, with what it streamed.
      await finalizePending(
        ctx,
        stored,
        { status: "success" },
        onSaveMessages,
        [...(stored.streamId ? [stored.streamId] : [])],
      );
      if (stored.streamId) await endStoppedStream(ctx, stored.streamId);
      return null;
    }
    await finalizePending(
      ctx,
      stored,
      result,
      onSaveMessages,
      stored.streamId ? [stored.streamId] : [],
    );
    await closeLinkedStream(ctx, stored, result.status === "success");
    const turnId = write.as === "turn" ? write.turnId : write.liveTurn?._id;
    if (turnId) {
      await settle(ctx, turnId, {
        byApp: write.as === "app",
        wroteFailed: result.status === "failed",
        reason: result.status === "failed" ? result.error : undefined,
      });
    }
    return null;
  },
});

/**
 * Settles a pending message: recovers what its streams carried, or marks it.
 * A durable row passes its own stream, so another attempt's stream at its
 * position is never read into it.
 */
export async function finalizePending(
  ctx: MutationCtx,
  stored: Doc<"messages">,
  result: { status: "success" } | { status: "failed"; error: string },
  onSaveMessages: string | undefined,
  onlyStreams?: Id<"streamingMessages">[],
) {
  const messageId = stored._id;
  const message = withText(stored);
  if (message.status !== "pending") {
    console.debug(
      "Trying to finalize a message that's already",
      message.status,
    );
    return null;
  }
  // See if we can add any in-progress data
  if (!message.message?.content.length) {
    const { messages, materializationFailures, streamsToRelease } =
      await getStreamingMessagesWithMetadata(ctx, message, result, onlyStreams);
    if (materializationFailures.length > 0) {
      console.error(
        "Failed to materialize persisted assistant streams",
        materializationFailures,
      );
      await markPendingMessageFailed(
        ctx,
        message,
        result.status === "failed" ? result.error : STREAM_RECOVERY_FAILURE,
        onSaveMessages,
      );
      return null;
    }
    if (messages.length > 0) {
      // Nested so an oversized recovered message rolls back on its own and
      // the pending message is marked failed instead of stuck.
      let recovered;
      try {
        const recovery = {
          messages,
          threadId: message.threadId,
          agentName: message.agentName,
          failPendingSteps: false,
          pendingMessageId: messageId,
          userId: message.userId,
          embeddings: undefined,
        };
        ({ messages: recovered } = message.turnId
          ? await ctx.runMutation(internal.messages._recover, {
              ...recovery,
              turnId: message.turnId,
            })
          : await ctx.runMutation(api.messages.addMessages, recovery));
      } catch (error) {
        console.error("Failed to persist recovered assistant streams", error);
        await markPendingMessageFailed(
          ctx,
          message,
          result.status === "failed" ? result.error : STREAM_RECOVERY_FAILURE,
          onSaveMessages,
        );
        return null;
      }
      await releaseStreamFileOwnershipByIds(ctx, streamsToRelease);
      // Reported here, not by the nested save, so a report that can't be
      // scheduled fails the finalize instead of reading as failed recovery.
      await reportSavedMessages(
        ctx,
        onSaveMessages,
        recovered.map((doc) => ({
          kind: doc._id === messageId ? "update" : "insert",
          doc,
        })),
      );
      return null;
    }
  }
  if (result.status === "failed") {
    await markPendingMessageFailed(ctx, message, result.error, onSaveMessages);
  } else {
    await writeMessage(ctx, messageId, { status: "success" });
    await reportSavedMessages(ctx, onSaveMessages, [
      { kind: "update", doc: { ...message, status: "success" } },
    ]);
  }
  return null;
}

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
          "reasoning",
          "reasoningDetails",
        ]),
      ),
    ),
    onSaveMessages: vOnSaveMessages,
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
      patch.tool = isTool(args.patch.message);
      patch.text = extractText(args.patch.message);
      Object.assign(patch, leaveOutText(args.patch.message, patch.text));
    }

    if (args.patch.status === "failed") {
      if (message.embeddingId) {
        const { tableName } = getVectorIdInfo(ctx, message.embeddingId);
        await ctx.db.delete(tableName, message.embeddingId);
      }
      patch.embeddingId = undefined;
    }

    const write = await authorizeRow(ctx, message);
    await writeMessage(ctx, args.messageId, patch);
    const turnId = write.as === "turn" ? write.turnId : write.liveTurn?._id;
    if (turnId && patch.status && patch.status !== "pending") {
      await closeLinkedStream(ctx, message, patch.status === "success");
    }
    if (turnId) {
      await settle(ctx, turnId, {
        byApp: write.as === "app",
        wroteFailed: patch.status === "failed",
        reason: patch.error,
      });
    }
    const updated = (await ctx.db.get("messages", args.messageId))!;
    await reportSavedMessages(ctx, args.onSaveMessages, [
      { kind: "update", doc: updated },
    ]);
    return publicMessage(updated);
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
    outputs: v.optional(
      v.array(
        v.object({
          toolCallId: v.string(),
          toolName: v.string(),
          output: v.union(
            v.object({ type: v.literal("text"), value: v.string() }),
            v.object({
              type: v.literal("json"),
              value: v.any(),
              providerOptions: v.optional(vProviderOptions),
            }),
            v.object({ type: v.literal("error-text"), value: v.string() }),
          ),
        }),
      ),
    ),
    onSaveMessages: vOnSaveMessages,
    // Continues the turn the request belongs to once its step is answered.
    generate: v.optional(v.string()),
  },
  returns: v.object({
    messageId: v.id("messages"),
    jobId: v.optional(vJobId),
  }),
  handler: async (ctx, args) => {
    const read: Doc<"messages">[] = [];
    const plan = await planToolCallResponses(
      recentMessages(ctx, args.threadId, read),
      { decisions: args.decisions, outputs: args.outputs ?? [] },
      args.threadId,
    );
    const request = read.find((doc) => doc._id === plan.requestMessageId)!;
    // Read newest first through the request, so the first message read at
    // the request's order is that order's last step.
    const last = read.find((doc) => doc.order === request.order)!;
    const turnPlan =
      request.turnId || args.generate !== undefined
        ? await planResponse(ctx, request, args.generate)
        : undefined;
    const saved = await addMessagesHandler(
      ctx,
      {
        threadId: args.threadId,
        agentName: args.agentName,
        promptMessageId: request._id,
        failPendingSteps: false,
        messages: [{ message: plan.message }],
        onSaveMessages: args.onSaveMessages,
      },
      { message: request, lastStepOrder: last.stepOrder },
      turnPlan,
    );
    return {
      messageId: saved.messages[0]._id as Id<"messages">,
      ...(saved.jobId ? { jobId: saved.jobId } : {}),
    };
  },
});

async function* recentMessages(
  ctx: QueryCtx,
  threadId: Id<"threads">,
  read: Doc<"messages">[],
) {
  for await (const doc of orderedMessagesStream(ctx, {
    threadId,
    sortOrder: "desc",
  })) {
    const message = withText(doc);
    read.push(message);
    yield message;
    if (read.length === APPROVAL_LOOKUP_MESSAGES) return;
  }
}

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
              "turnId",
              "jobId",
              "streamId",
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
  const found =
    args.upToAndIncludingMessageId &&
    (await ctx.db.get("messages", args.upToAndIncludingMessageId));
  // Another thread's message reads as missing.
  const last = found && found.threadId === args.threadId ? found : null;
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
