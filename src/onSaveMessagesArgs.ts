import { v, type Infer } from "convex/values";
import { vMessageStatus } from "./validators.js";

// Not in validators.ts: every component function loads that module, and only
// the dispatcher needs this one.

/**
 * The args of an Agent's `onSaveMessages` mutation: the messages one save
 * wrote to a thread, and how. Reports can arrive out of order, so read the
 * messages by id for their current state, and place them by `order` and
 * `stepOrder` rather than by arrival.
 */
export const vOnSaveMessagesArgs = v.object({
  threadId: v.string(),
  messages: v.array(
    v.object({
      kind: v.union(
        v.literal("insert"),
        v.literal("update"),
        v.literal("delete"),
      ),
      messageId: v.string(),
      order: v.number(),
      stepOrder: v.number(),
      status: vMessageStatus,
    }),
  ),
});
export type OnSaveMessagesArgs = Infer<typeof vOnSaveMessagesArgs>;
