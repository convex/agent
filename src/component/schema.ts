import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vThreadStatus,
  vMessage,
  vMessageStatus,
  vUsage,
  vSource,
  vLanguageModelCallWarning,
  vFinishReason,
  vProviderOptions,
  vProviderMetadata,
  vReasoningDetails,
} from "../validators.js";
import { typedV } from "convex-helpers/validators";
import vectorTables, { vVectorId } from "./vector/tables.js";

export const schema = defineSchema({
  threads: defineTable({
    userId: v.optional(v.string()), // Unset for anonymous
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    status: vThreadStatus,
    // DEPRECATED
    defaultSystemPrompt: v.optional(v.string()),
    parentThreadIds: v.optional(v.array(v.id("threads"))),
    order: /*DEPRECATED*/ v.optional(v.number()),
  })
    .index("userId", ["userId"])
    .searchIndex("title", { searchField: "title", filterFields: ["userId"] }),
  messages: defineTable({
    userId: v.optional(v.string()), // useful for searching across threads
    threadId: v.id("threads"),
    order: v.number(),
    stepOrder: v.number(),
    embeddingId: v.optional(vVectorId),
    fileIds: v.optional(v.array(v.id("files"))),
    error: v.optional(v.string()),
    status: vMessageStatus,

    // Context on how it was generated
    agentName: v.optional(v.string()),
    model: v.optional(v.string()),
    provider: v.optional(v.string()),
    providerOptions: v.optional(vProviderOptions), // Sent to model

    // The result
    message: v.optional(vMessage),
    // Convenience fields extracted from the message
    tool: v.boolean(), // either tool call (assistant) or tool result (tool)
    text: v.optional(v.string()),

    // Result metadata
    usage: v.optional(vUsage),
    providerMetadata: v.optional(vProviderMetadata), // Received from model
    sources: v.optional(v.array(vSource)),
    warnings: v.optional(v.array(vLanguageModelCallWarning)),
    finishReason: v.optional(vFinishReason),
    // Likely deprecated soon
    reasoning: v.optional(v.string()),
    reasoningDetails: v.optional(vReasoningDetails),
    // DEPRECATED
    id: v.optional(v.string()), // external id, e.g. from Vercel AI SDK
    parentMessageId: v.optional(v.id("messages")),
    stepId: v.optional(v.string()),
    files: v.optional(v.array(v.any())),
  })
    // Allows finding successful visible messages in order
    // Also surface pending messages separately to e.g. stream
    .index("threadId_status_tool_order_stepOrder", [
      "threadId",
      "status",
      // TODO: we might not need this to be in the index..
      "tool",
      "order",
      "stepOrder",
    ])
    // Allows text search on message content
    .searchIndex("text_search", {
      searchField: "text",
      filterFields: ["userId", "threadId"],
    })
    // Allows finding messages by vector embedding id
    .index("embeddingId_threadId", ["embeddingId", "threadId"]),

  /**
   * Generations' claim on a pending message an app saved, `messageId`. The
   * messages saved under it can change role and status; only the claim says
   * whether it was answered.
   */
  claims: defineTable({
    threadId: v.id("threads"),
    messageId: v.id("messages"),
    /** When the current attempt claimed it. */
    claimedAt: v.number(),
    /** The current attempt's pending message, or the last one it saved. */
    latestMessageId: v.id("messages"),
    /** The key's prompt, which saving into the key can overwrite. */
    promptMessageId: v.optional(v.id("messages")),
    /** Set only by the save that ends a generation that finished. */
    answered: v.boolean(),
  })
    .index("threadId_messageId", ["threadId", "messageId"])
    .index("latestMessageId", ["latestMessageId"]),

  // Status: if it's done, it's deleted, then deltas are vacuumed
  streamingMessages: defineTable({
    // extra metadata?
    userId: v.optional(v.string()),
    agentName: v.optional(v.string()),
    model: v.optional(v.string()),
    provider: v.optional(v.string()),
    providerOptions: v.optional(vProviderOptions), // Sent to model
    // The data format for the deltas. By default, we use UIMessageChunks.
    // This format dictates how the messages are materialized for capturing
    // partial messages during failure, as well as on the client side.
    format: v.optional(
      v.union(v.literal("UIMessageChunk"), v.literal("TextStreamPart")),
    ),

    threadId: v.id("threads"),
    order: v.number(),
    /** Internal ownership sidecar for files materialized in stream deltas. */
    fileRefs: v.optional(
      v.array(
        v.object({
          url: v.string(),
          fileId: v.id("files"),
        }),
      ),
    ),
    /** The pending message this stream's generation saves into next. */
    pendingMessageId: v.optional(v.id("messages")),
    /**
     * The step order of the first message in the stream.
     * If the stream ends up with both a tool call and a tool result,
     * the stepOrder of the result will be +1 of the tool call.
     */
    stepOrder: v.number(),
    state: v.union(
      v.object({
        kind: v.literal("streaming"),
        lastHeartbeat: v.number(),
        timeoutFnId: v.optional(v.id("_scheduled_functions")),
      }),
      v.object({
        kind: v.literal("finished"),
        endedAt: v.number(),
        cleanupFnId: v.optional(v.id("_scheduled_functions")),
      }),
      v.object({
        kind: v.literal("aborted"),
        reason: v.string(),
        cleanupFnId: v.optional(v.id("_scheduled_functions")),
      }),
    ),
  })
    // There should only be one per "order" index
    // If another exists, it's deleted and replaced
    .index("threadId_state_order_stepOrder", [
      "threadId",
      "state.kind",
      "order",
      "stepOrder",
    ]),

  streamDeltas: defineTable({
    streamId: v.id("streamingMessages"),
    // the indexes work like: 0 <first> 1 <second> 2 <third> 3 ...
    start: v.number(), // inclusive
    end: v.number(), // exclusive
    parts: v.array(v.any()),
  }).index("streamId_start_end", ["streamId", "start", "end"]),

  files: defineTable({
    storageId: v.string(),
    mediaType: v.optional(v.string()),
    /** @deprecated Use `mediaType` instead. */
    mimeType: v.optional(v.string()),
    filename: v.optional(v.string()),
    hash: v.string(),
    refcount: v.number(),
    lastTouchedAt: v.number(),
  })
    .index("hash", ["hash"])
    .index("refcount_lastTouchedAt", ["refcount", "lastTouchedAt"]),
  ...vectorTables,
  // To authenticate playground usage
  // Delete a key to invalidate it
  // Provide a name to easily identify it / invalidate by name
  apiKeys: defineTable({ name: v.optional(v.string()) }).index("name", [
    "name",
  ]),
});

export const vv = typedV(schema);
export { vv as v };

export default schema;
