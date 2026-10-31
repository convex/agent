// See the docs at https://docs.convex.dev/agents/batch
import { defineTable } from "convex/server";
import { v } from "convex/values";

export default {
  batches: defineTable({
    // The AI SDK's batch reference, set once the provider accepts the batch.
    batch: v.optional(
      v.object({
        version: v.literal(2),
        id: v.string(),
        provider: v.string(),
      }),
    ),
    status: v.union(v.literal("pending"), v.literal("done")),
    // Lets a provider webhook trigger a poll without being trusted otherwise.
    webhookToken: v.string(),
    // Each request's id is its pending answer, which answers its prompt.
    items: v.array(
      v.object({
        threadId: v.string(),
        promptMessageId: v.string(),
        pendingMessageId: v.string(),
      }),
    ),
  }),
};
