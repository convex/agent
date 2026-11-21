import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { internal } from "./component/_generated/api.js";
import type { Doc } from "./component/_generated/dataModel.js";
import type { MutationCtx } from "./component/_generated/server.js";
import type { OnSaveMessagesArgs } from "./onSaveMessagesArgs.js";

// Lives outside src/component, and names the dispatcher instead of importing
// `internal`, so the component bundle gains no chunks: every chunk a function
// loads adds to every call of it, hook or not.

/** An Agent's `onSaveMessages`, as a function handle. */
export const vOnSaveMessages = v.optional(v.string());

type Kind = OnSaveMessagesArgs["messages"][number]["kind"];
export type SavedMessage = {
  kind: Kind;
  doc: Pick<Doc<"messages">, "order" | "stepOrder" | "status"> & {
    _id: string;
    threadId: string;
  };
};

const dispatch = makeFunctionReference(
  "onSaveMessages:dispatch",
) as unknown as typeof internal.onSaveMessages.dispatch;

// One scheduled function per save, however many threads it touched: the
// dispatcher fans out. Only ids and positions are passed: whole docs could
// exceed the scheduler's argument limit on a large delete.
export async function reportSavedMessages(
  ctx: MutationCtx,
  handle: string,
  saved: SavedMessage[],
) {
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
  if (byThread.size === 0) return;
  await ctx.scheduler.runAfter(0, dispatch, {
    handle,
    reports: [...byThread].map(([threadId, messages]) => ({
      threadId,
      messages,
    })),
  });
}
