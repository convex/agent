import { omit, pick } from "convex-helpers";
import { v } from "convex/values";
import {
  type MessageWithMetadataInternal,
  type StreamDelta,
  type StreamMessage,
  vStreamDelta,
  vStreamMessage,
} from "../validators.js";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalMutation,
  mutation,
  type MutationCtx,
  query,
  action,
} from "./_generated/server.js";
import schema from "./schema.js";
import { stream } from "convex-helpers/server/stream";
import { mergedStream } from "convex-helpers/server/stream";
import { paginator } from "convex-helpers/server/pagination";
import type { WithoutSystemFields } from "convex/server";
import {
  getPersistedUIMessageChunkParts,
  projectPersistedUIMessageChunks,
} from "../streaming/materializePersistedUIMessageChunks.js";
import { changeRefcount } from "./files.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const MAX_DELTAS_PER_REQUEST = 1000;
const MAX_DELTAS_PER_STREAM = 100;
// Half the 16 MiB read and 32,000 document transaction limits, shared across a
// step's streams, leaving room for the rest of finalizeMessage.
export const MAX_MATERIALIZATION_BYTES = 8 * 1024 * 1024;
export const MAX_MATERIALIZATION_ROWS = 16_000;
export const MAX_MATERIALIZATION_STREAMS = 10;

// Mirrors convex/values size.js; getConvexSize is newer than the oldest
// convex this package supports.
export function convexValueSize(value: unknown): number {
  if (value === undefined) return 0;
  if (value === null || typeof value === "boolean") return 1;
  if (typeof value === "number" || typeof value === "bigint") return 9;
  if (typeof value === "string") return 2 + utf8Length(value);
  if (value instanceof ArrayBuffer) return 2 + value.byteLength;
  if (Array.isArray(value)) {
    return value.reduce<number>((size, v) => size + convexValueSize(v), 2);
  }
  let size = 2;
  for (const [key, v] of Object.entries(value as object)) {
    if (v !== undefined) size += utf8Length(key) + 1 + convexValueSize(v);
  }
  return size;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Scheduled deletion jobs store their cursor in function args. Ones scheduled
 * before the switch from convex-helpers' paginator to built-in `.paginate()`
 * hold paginator cursors: JSON arrays of index key values ending in
 * `_creationTime` (number) and `_id` (string), or `[]` when done. Those aren't
 * valid built-in cursors, so restart from the beginning, which is safe since
 * these jobs delete rows as they read them.
 */
export function deletionCursor(cursor: string | null | undefined) {
  if (!cursor) return null;
  try {
    const key: unknown = JSON.parse(cursor);
    if (
      Array.isArray(key) &&
      (key.length === 0 ||
        (typeof key.at(-2) === "number" && typeof key.at(-1) === "string"))
    ) {
      return null;
    }
  } catch {
    // Not JSON, so not a paginator cursor.
  }
  return cursor;
}

// Half the 16 MiB read limit across a request's cursors.
const MAX_DELTA_BYTES_PER_REQUEST = 8 * 1024 * 1024;
const MAX_BYTES_READ_PER_DELETE = 1024 * 1024;
// Pages are read twice (paginate, then delete), so this is ~8 MiB per transaction.
const MAX_SYNC_DELETE_PAGES = 4;
const TIMEOUT_INTERVAL = 10 * MINUTE;
const DELETE_STREAM_DELAY = MINUTE * 5; // 5 minutes

const deltaValidator = schema.tables.streamDeltas.validator;
const streamFileRefValidator = v.object({
  url: v.string(),
  fileId: v.id("files"),
});

export const addDelta = mutation({
  args: {
    ...deltaValidator.fields,
    fileRefs: v.optional(v.array(streamFileRefValidator)),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const stream = await ctx.db.get("streamingMessages", args.streamId);
    if (!stream) {
      console.warn("Stream not found", args.streamId);
      return false;
    }
    if (stream.state.kind !== "streaming") {
      return false;
    }
    const { fileRefs, ...delta } = args;
    if (fileRefs?.length) {
      const previous = stream.fileRefs ?? [];
      // The persisted chunks refer to files by URL. Several URLs can still
      // resolve to one durable file, but a URL must resolve to exactly one.
      const refsByUrl = new Map(previous.map((ref) => [ref.url, ref] as const));
      for (const ref of fileRefs) {
        const existing = refsByUrl.get(ref.url);
        if (existing && existing.fileId !== ref.fileId) {
          throw new Error(`Stream file URL maps to multiple files: ${ref.url}`);
        }
        refsByUrl.set(ref.url, ref);
      }
      const next = [...refsByUrl.values()];
      await changeRefcount(
        ctx,
        previous.map(({ fileId }) => fileId),
        next.map(({ fileId }) => fileId),
      );
      await ctx.db.patch("streamingMessages", args.streamId, {
        fileRefs: next,
      });
    }
    await ctx.db.insert("streamDeltas", delta);
    await heartbeatStream(ctx, { streamId: args.streamId });
    return true;
  },
});

export const listDeltas = query({
  args: {
    threadId: v.id("threads"),
    cursors: v.array(
      v.object({ streamId: v.id("streamingMessages"), cursor: v.number() }),
    ),
  },
  returns: v.array(vStreamDelta),
  handler: async (ctx, args): Promise<StreamDelta[]> => {
    let totalDeltas = 0;
    let bytesRemaining = MAX_DELTA_BYTES_PER_REQUEST;
    const deltas: StreamDelta[] = [];
    for (const cursor of args.cursors) {
      const stream = await ctx.db.get("streamingMessages", cursor.streamId);
      // Clients can retain cursors after a stream has been cleaned up.
      if (!stream) continue;
      if (stream.threadId !== args.threadId) {
        throw new Error("Stream does not belong to the given thread");
      }
      // Uses paginator: queries may only call built-in .paginate() once per
      // transaction, and this reads one page per stream.
      const { page } = await paginator(ctx.db, schema)
        .query("streamDeltas")
        .withIndex("streamId_start_end", (q) =>
          q.eq("streamId", cursor.streamId).gte("start", cursor.cursor),
        )
        .paginate({
          numItems: Math.min(
            MAX_DELTAS_PER_STREAM,
            MAX_DELTAS_PER_REQUEST - totalDeltas,
          ),
          maximumBytesRead: bytesRemaining,
          cursor: null,
        });
      totalDeltas += page.length;
      for (const d of page) {
        bytesRemaining -= convexValueSize(d);
        deltas.push(pick(d, ["streamId", "start", "end", "parts"]));
      }
      if (totalDeltas >= MAX_DELTAS_PER_REQUEST || bytesRemaining <= 0) {
        break;
      }
    }
    return deltas;
  },
});

export const create = mutation({
  args: omit(schema.tables.streamingMessages.validator.fields, [
    "state",
    "fileRefs",
  ]),
  returns: v.id("streamingMessages"),
  handler: async (ctx, args) => {
    const state = { kind: "streaming" as const, lastHeartbeat: Date.now() };
    // TODO: enforce order/stepOrder uniqueness?
    const streamId = await ctx.db.insert("streamingMessages", {
      ...args,
      state,
    });
    const timeoutFnId = await ctx.scheduler.runAfter(
      TIMEOUT_INTERVAL,
      internal.streams.timeoutStream,
      { streamId },
    );
    await ctx.db.patch("streamingMessages", streamId, {
      state: { ...state, timeoutFnId },
    });
    return streamId;
  },
});

export const list = query({
  args: {
    threadId: v.id("threads"),
    startOrder: v.optional(v.number()),
    statuses: v.optional(
      v.array(
        v.union(
          v.literal("streaming"),
          v.literal("finished"),
          v.literal("aborted"),
        ),
      ),
    ),
  },
  returns: v.array(vStreamMessage),
  handler: async (ctx, args) => {
    const statuses = args.statuses ?? ["streaming"];
    const messages = await mergedStream(
      statuses.map((status) =>
        stream(ctx.db, schema)
          .query("streamingMessages")
          .withIndex("threadId_state_order_stepOrder", (q) =>
            q
              .eq("threadId", args.threadId)
              .eq("state.kind", status)
              .gte("order", args.startOrder ?? 0),
          )
          .order("desc"),
      ),
      ["order", "stepOrder"],
    ).take(100);

    return messages.map((m) => publicStreamMessage(m));
  },
});

function publicStreamMessage(m: Doc<"streamingMessages">): StreamMessage {
  return {
    streamId: m._id,
    status: m.state.kind,
    ...pick(m, [
      "format",
      "order",
      "stepOrder",
      "userId",
      "agentName",
      "model",
      "provider",
      "providerOptions",
    ]),
  };
}

export async function abortStreamsAtOrder(
  ctx: MutationCtx,
  args: { threadId: Id<"threads">; order: number; reason: string },
) {
  const streams = await ctx.db
    .query("streamingMessages")
    .withIndex("threadId_state_order_stepOrder", (q) =>
      q
        .eq("threadId", args.threadId)
        .eq("state.kind", "streaming")
        .eq("order", args.order),
    )
    .take(100);
  for (const stream of streams) {
    await abortById(ctx, { streamId: stream._id, reason: args.reason });
  }
  return streams.length > 0;
}

export const abortByOrder = mutation({
  args: { threadId: v.id("threads"), order: v.number(), reason: v.string() },
  returns: v.boolean(),
  handler: abortStreamsAtOrder,
});

export const abort = mutation({
  args: {
    streamId: v.id("streamingMessages"),
    reason: v.string(),
    finalDelta: v.optional(deltaValidator),
  },
  returns: v.boolean(),
  handler: abortById,
});

async function abortById(
  ctx: MutationCtx,
  args: {
    streamId: Id<"streamingMessages">;
    reason: string;
    finalDelta?: WithoutSystemFields<Doc<"streamDeltas">>;
  },
) {
  const stream = await ctx.db.get("streamingMessages", args.streamId);
  if (!stream) {
    throw new Error(`Stream not found: ${args.streamId}`);
  }
  if (args.finalDelta) {
    await ctx.db.insert("streamDeltas", args.finalDelta);
  }
  if (stream.state.kind !== "streaming") {
    return false;
  }
  await cleanupTimeoutFn(ctx, stream);
  const cleanupFnId = await scheduleStreamDeletion(ctx, args.streamId);
  await ctx.db.patch("streamingMessages", args.streamId, {
    state: { kind: "aborted", reason: args.reason, cleanupFnId },
  });
  return true;
}

async function cleanupTimeoutFn(
  ctx: MutationCtx,
  stream: Doc<"streamingMessages">,
) {
  if (stream.state.kind === "streaming" && stream.state.timeoutFnId) {
    const timeoutFn = await ctx.db.system.get(
      "_scheduled_functions",
      stream.state.timeoutFnId,
    );
    if (timeoutFn?.state.kind === "pending") {
      await ctx.scheduler.cancel(stream.state.timeoutFnId);
    }
  }
}

// No longer used from the DeltaStreamer
export const finish = mutation({
  args: {
    streamId: v.id("streamingMessages"),
    finalDelta: v.optional(deltaValidator),
  },
  returns: v.null(),
  handler: finishHandler,
});

export async function finishHandler(
  ctx: MutationCtx,
  args: {
    streamId: Id<"streamingMessages">;
    finalDelta?: WithoutSystemFields<Doc<"streamDeltas">>;
  },
) {
  if (args.finalDelta) {
    await ctx.db.insert("streamDeltas", args.finalDelta);
  }
  const stream = await ctx.db.get("streamingMessages", args.streamId);
  if (!stream) {
    throw new Error(`Stream not found: ${args.streamId}`);
  }
  if (stream.state.kind !== "streaming") {
    console.warn(
      `Stream trying to finish ${args.streamId} but is ${stream.state.kind}`,
    );
    return;
  }
  await cleanupTimeoutFn(ctx, stream);
  const cleanupFnId = await scheduleStreamDeletion(ctx, args.streamId);
  await ctx.db.patch("streamingMessages", args.streamId, {
    state: { kind: "finished", endedAt: Date.now(), cleanupFnId },
  });
}

// TODO: use this heartbeat while streaming, every 30 seconds or so,
// then reduce the timeout to 60 seconds.
export const heartbeat = mutation({
  args: { streamId: v.id("streamingMessages") },
  returns: v.null(),
  handler: heartbeatStream,
});

async function releaseStreamFileOwnership(
  ctx: MutationCtx,
  stream: Doc<"streamingMessages">,
) {
  if (!stream.fileRefs?.length) return;
  await changeRefcount(
    ctx,
    stream.fileRefs.map(({ fileId }) => fileId),
    [],
  );
}

async function scheduleStreamDeletion(
  ctx: MutationCtx,
  streamId: Id<"streamingMessages">,
) {
  return ctx.scheduler.runAfter(
    DELETE_STREAM_DELAY,
    api.streams.deleteStreamAsync,
    { streamId },
  );
}

async function heartbeatStream(
  ctx: MutationCtx,
  args: { streamId: Id<"streamingMessages"> },
): Promise<void> {
  const stream = await ctx.db.get("streamingMessages", args.streamId);
  if (!stream) {
    console.warn("Stream not found", args.streamId);
    return;
  }
  if (stream.state.kind !== "streaming") {
    return;
  }
  if (Date.now() - stream.state.lastHeartbeat < TIMEOUT_INTERVAL / 4) {
    // Debounce heartbeating.
    return;
  }
  if (!stream.state.timeoutFnId) {
    throw new Error("Stream has no timeout function");
  }
  const timeoutFn = await ctx.db.system.get(
    "_scheduled_functions",
    stream.state.timeoutFnId,
  );
  if (!timeoutFn) {
    throw new Error("Timeout function not found");
  }
  if (timeoutFn.state.kind !== "pending") {
    throw new Error("Timeout function is not pending");
  }
  await ctx.scheduler.cancel(stream.state.timeoutFnId);
  const timeoutFnId = await ctx.scheduler.runAfter(
    TIMEOUT_INTERVAL,
    internal.streams.timeoutStream,
    { streamId: args.streamId },
  );
  await ctx.db.patch("streamingMessages", args.streamId, {
    state: { kind: "streaming", lastHeartbeat: Date.now(), timeoutFnId },
  });
}

export const timeoutStream = internalMutation({
  args: { streamId: v.id("streamingMessages") },
  returns: v.null(),
  handler: timeoutStreamHandler,
});

export async function timeoutStreamHandler(
  ctx: MutationCtx,
  args: { streamId: Id<"streamingMessages"> },
) {
  const stream = await ctx.db.get("streamingMessages", args.streamId);
  if (!stream || stream.state.kind !== "streaming") {
    console.warn("Stream not found", args.streamId);
    return;
  }
  const cleanupFnId = await scheduleStreamDeletion(ctx, args.streamId);
  await ctx.db.patch("streamingMessages", args.streamId, {
    state: { kind: "aborted", reason: "timeout", cleanupFnId },
  });
}

async function deletePageForStreamId(
  ctx: MutationCtx,
  args: { streamId: Id<"streamingMessages">; cursor?: string },
) {
  const deltas = await ctx.db
    .query("streamDeltas")
    .withIndex("streamId_start_end", (q) => q.eq("streamId", args.streamId))
    .paginate({
      numItems: MAX_DELTAS_PER_REQUEST,
      maximumBytesRead: MAX_BYTES_READ_PER_DELETE,
      cursor: deletionCursor(args.cursor),
    });
  await Promise.all(
    deltas.page.map((d) => ctx.db.delete("streamDeltas", d._id)),
  );
  if (deltas.isDone) {
    const stream = await ctx.db.get("streamingMessages", args.streamId);
    if (stream) {
      await releaseStreamFileOwnership(ctx, stream);
      await cleanupTimeoutFn(ctx, stream);
      if (
        (stream.state.kind === "finished" || stream.state.kind === "aborted") &&
        stream.state.cleanupFnId
      ) {
        const scheduledFunction = await ctx.db.system.get(
          "_scheduled_functions",
          stream.state.cleanupFnId,
        );
        if (scheduledFunction?.state.kind === "pending") {
          await ctx.scheduler.cancel(stream.state.cleanupFnId);
        }
      }
      await ctx.db.delete("streamingMessages", args.streamId);
    }
  }
  return deltas;
}

export async function releaseStreamFileOwnershipByIds(
  ctx: MutationCtx,
  streamIds: Id<"streamingMessages">[],
) {
  for (const streamId of new Set(streamIds)) {
    const stream = await ctx.db.get("streamingMessages", streamId);
    if (!stream?.fileRefs?.length) continue;
    await releaseStreamFileOwnership(ctx, stream);
    await ctx.db.patch("streamingMessages", streamId, { fileRefs: undefined });
  }
}

export async function deleteStreamsPageForThreadId(
  ctx: MutationCtx,
  args: { threadId: Id<"threads">; streamOrder?: number; deltaCursor?: string },
) {
  const allStreamMessages =
    schema.tables.streamingMessages.validator.fields.state.members
      .flatMap((state) => state.fields.kind.value)
      .map((stateKind) =>
        stream(ctx.db, schema)
          .query("streamingMessages")
          .withIndex("threadId_state_order_stepOrder", (q) =>
            q
              .eq("threadId", args.threadId)
              .eq("state.kind", stateKind)
              .gte("order", args.streamOrder ?? 0),
          ),
      );
  let deltaCursor = args.deltaCursor;
  const streamMessage = await mergedStream(allStreamMessages, [
    "order",
    "stepOrder",
  ]).first();
  if (!streamMessage) {
    return { isDone: true, streamOrder: undefined, deltaCursor: undefined };
  }
  const result = await deletePageForStreamId(ctx, {
    streamId: streamMessage._id,
    cursor: deltaCursor,
  });
  if (result.isDone) {
    deltaCursor = undefined;
  }
  return { isDone: false, streamOrder: streamMessage.order, deltaCursor };
}

export const deleteStreamsPageForThreadIdMutation = internalMutation({
  args: {
    threadId: v.id("threads"),
    streamOrder: v.optional(v.number()),
    deltaCursor: v.optional(v.string()),
  },
  returns: v.object({
    isDone: v.boolean(),
    streamOrder: v.optional(v.number()),
    deltaCursor: v.optional(v.string()),
  }),
  handler: deleteStreamsPageForThreadId,
});

export const deleteAllStreamsForThreadIdAsync = mutation({
  args: {
    threadId: v.id("threads"),
    streamOrder: v.optional(v.number()),
    deltaCursor: v.optional(v.string()),
  },
  returns: v.object({
    isDone: v.boolean(),
    streamOrder: v.optional(v.number()),
    deltaCursor: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    isDone: boolean;
    streamOrder?: number;
    deltaCursor?: string;
  }> => {
    const result = await deleteStreamsPageForThreadId(ctx, args);
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        api.streams.deleteAllStreamsForThreadIdAsync,
        {
          threadId: args.threadId,
          streamOrder: result.streamOrder,
          deltaCursor: result.deltaCursor,
        },
      );
    } else {
      await ctx.db.delete("threads", args.threadId);
    }
    return result;
  },
});

export const deleteStreamSync = mutation({
  args: { streamId: v.id("streamingMessages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    let deltas = await deletePageForStreamId(ctx, args);
    for (let pages = 1; !deltas.isDone; pages++) {
      if (pages >= MAX_SYNC_DELETE_PAGES) {
        throw new Error(
          `Stream ${args.streamId} has too many deltas to delete in one transaction; use deleteStreamAsync`,
        );
      }
      deltas = await deletePageForStreamId(ctx, {
        ...args,
        cursor: deltas.continueCursor,
      });
    }
  },
});

export const deleteStreamAsync = mutation({
  args: { streamId: v.id("streamingMessages"), cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await deletePageForStreamId(ctx, args);
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, api.streams.deleteStreamAsync, {
        streamId: args.streamId,
        cursor: result.continueCursor,
      });
    }
  },
});

export const deleteAllStreamsForThreadIdSync = action({
  args: { threadId: v.id("threads") },
  returns: v.null(),
  handler: async (ctx, args) => {
    let result = await ctx.runMutation(
      internal.streams.deleteStreamsPageForThreadIdMutation,
      args,
    );
    while (!result.isDone) {
      result = await ctx.runMutation(
        internal.streams.deleteStreamsPageForThreadIdMutation,
        {
          ...args,
          streamOrder: result.streamOrder,
          deltaCursor: result.deltaCursor,
        },
      );
    }
  },
});

export async function getStreamingMessages(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  order: number,
  stepOrder: number,
): Promise<Doc<"streamingMessages">[]> {
  return mergedStream(
    (["aborted", "streaming", "finished"] as const).map((state) =>
      stream(ctx.db, schema)
        .query("streamingMessages")
        .withIndex("threadId_state_order_stepOrder", (q) =>
          q
            .eq("threadId", threadId)
            .eq("state.kind", state)
            .eq("order", order)
            .lte("stepOrder", stepOrder),
        )
        .order("desc"),
    ),
    ["stepOrder"],
  ).take(MAX_MATERIALIZATION_STREAMS + 1);
}

export async function getStreamingMessagesWithMetadata(
  ctx: MutationCtx,
  {
    threadId,
    order,
    stepOrder,
  }: { threadId: Id<"threads">; order: number; stepOrder: number },
  metadata: { status: "success" | "failed"; error?: string },
): Promise<{
  messages: MessageWithMetadataInternal[];
  materializationFailures: Array<{
    streamId: Id<"streamingMessages">;
    reason: string;
  }>;
  streamsToRelease: Id<"streamingMessages">[];
}> {
  const streamingMessages = await getStreamingMessages(
    ctx,
    threadId,
    order,
    stepOrder,
  );
  const failure = (streamId: Id<"streamingMessages">, reason: string) => ({
    messages: [],
    materializationFailures: [{ streamId, reason }],
    streamsToRelease: [],
  });
  if (streamingMessages.length > MAX_MATERIALIZATION_STREAMS) {
    return failure(
      streamingMessages[0]._id,
      `Order ${order} has more than ${MAX_MATERIALIZATION_STREAMS} streams to recover`,
    );
  }
  let bytesRemaining = MAX_MATERIALIZATION_BYTES;
  let rowsRemaining = MAX_MATERIALIZATION_ROWS;
  const messages: MessageWithMetadataInternal[] = [];
  const streamsToRelease: Id<"streamingMessages">[] = [];
  for (const streamingMessage of streamingMessages) {
    try {
      // Uses paginator, like listDeltas: it reads one page per stream, and
      // built-in .paginate() is limited to once per transaction in queries.
      // (This is called from the finalizeMessage mutation.)
      const deltas = await paginator(ctx.db, schema)
        .query("streamDeltas")
        .withIndex("streamId_start_end", (q) =>
          q.eq("streamId", streamingMessage._id),
        )
        .paginate({
          numItems: rowsRemaining,
          maximumRowsRead: rowsRemaining,
          maximumBytesRead: bytesRemaining,
          cursor: null,
        });
      if (!deltas.isDone) {
        throw new Error(
          `Delta logs for order ${order} exceed the ${MAX_MATERIALIZATION_BYTES} byte or ${MAX_MATERIALIZATION_ROWS} document recovery budget at stream ${streamingMessage._id}`,
        );
      }
      rowsRemaining -= deltas.page.length;
      for (const delta of deltas.page) {
        bytesRemaining -= convexValueSize(delta);
      }
      const { parts } = getPersistedUIMessageChunkParts(deltas.page);
      // We don't save messages that have already been saved
      const numToSkip = stepOrder - streamingMessage.stepOrder;
      messages.push(
        ...projectPersistedUIMessageChunks(
          publicStreamMessage(streamingMessage),
          parts,
          metadata,
          streamingMessage.fileRefs,
        ).slice(numToSkip),
      );
      streamsToRelease.push(streamingMessage._id);
    } catch (error) {
      return failure(
        streamingMessage._id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { messages, materializationFailures: [], streamsToRelease };
}
