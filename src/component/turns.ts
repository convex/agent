// Durable generations into an app-saved pending message. Only fields these
// mutations wrote can permit a turn action. What they read from shared
// messages can only refuse one.
//
// Nothing a plain entry loads may import this module (bundleGraph.test.ts).
import { assert, omit } from "convex-helpers";
import type {
  MessageContentParts,
  MessageWithMetadataInternal,
} from "../validators.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, type MutationCtx } from "./_generated/server.js";
import {
  addMessagesArgs,
  addMessagesHandler,
  markPendingMessageFailed,
  orderedMessagesStream,
} from "./messages.js";
import { v } from "./schema.js";

// An action can't run longer than 10 minutes, so a holder whose lease has
// expired is dead. A holder that is somehow still alive is still fenced out by
// `attempt`. The lease is never renewed.
const LEASE = 15 * 60 * 1000;

const vRefusal = v.object({
  code: v.union(v.literal("TurnBusy"), v.literal("TurnEnded")),
  retryAt: v.optional(v.number()),
  error: v.optional(v.string()),
});

// Refusals are returned, not thrown, so a refusal that stops the turn commits.
const busy = (turn: Doc<"turns">) => ({
  refused: {
    code: "TurnBusy" as const,
    ...(turn.leaseUntil !== undefined &&
      turn.leaseUntil > Date.now() && { retryAt: turn.leaseUntil }),
  },
});
const ended = (error?: string) => ({
  refused: { code: "TurnEnded" as const, ...(error && { error }) },
});

async function stop(
  ctx: MutationCtx,
  turn: Doc<"turns">,
  error: string,
  slot?: Doc<"messages"> | null,
) {
  await ctx.db.patch("turns", turn._id, {
    end: "stopped",
    error,
    leaseUntil: undefined,
  });
  slot ??= turn.slotId && (await ctx.db.get("messages", turn.slotId));
  if (slot?.status === "pending") {
    await markPendingMessageFailed(ctx, slot, error);
  }
  return ended(error);
}

/**
 * Reads K, the anchor and the slot, only to refuse: the turn stops if any of
 * them is gone or no longer usable.
 */
async function check(ctx: MutationCtx, turn: Doc<"turns">) {
  const key = await ctx.db.get("messages", turn.messageId);
  const slot =
    turn.slotId === turn.messageId
      ? key
      : turn.slotId && (await ctx.db.get("messages", turn.slotId));
  if (!key || key.status === "failed") {
    return {
      slot,
      error: `The turn's pending message was ${key ? "failed" : "deleted"}`,
    };
  }
  if (turn.anchorId !== turn.messageId) {
    const prompt = await ctx.db.get("messages", turn.anchorId);
    if (!prompt || prompt.status === "failed") {
      return {
        slot,
        error: `The turn's prompt was ${prompt ? "failed" : "deleted"}`,
      };
    }
  }
  if (turn.slotId && slot?.status !== "pending") {
    return {
      slot,
      error:
        "The turn's pending message was filled, failed or deleted by another writer",
    };
  }
  return { slot };
}

export const claim = mutation({
  args: { threadId: v.id("threads"), messageId: v.id("messages") },
  returns: v.union(
    v.object({ refused: vRefusal }),
    v.object({
      turnId: v.id("turns"),
      attempt: v.number(),
      step: v.number(),
      order: v.number(),
      slotId: v.id("messages"),
      stepOrder: v.number(),
      anchorId: v.id("messages"),
      takeover: v.boolean(),
    }),
  ),
  handler: async (ctx, { threadId, messageId }) => {
    let turn = await ctx.db
      .query("turns")
      .withIndex("messageId", (q) => q.eq("messageId", messageId))
      .unique();
    if (!turn) {
      // Turn rows are deleted only after their thread's messages, so no row
      // while K and its thread are here means K was never claimed.
      assert(
        await ctx.db.get("threads", threadId),
        `Thread ${threadId} not found`,
      );
      const key = await ctx.db.get("messages", messageId);
      assert(key, `Message ${messageId} not found`);
      assert(
        key.threadId === threadId,
        `Message ${messageId} is not in thread ${threadId}`,
      );
      assert(
        key.status === "pending",
        `Message ${messageId} is ${key.status}, not pending`,
      );
      const first = await orderedMessagesStream(ctx, {
        threadId,
        sortOrder: "asc",
        startOrder: key.order,
        startOrderBound: "eq",
      }).first();
      const turnId = await ctx.db.insert("turns", {
        threadId,
        messageId,
        order: key.order,
        anchorId:
          first && first.stepOrder < key.stepOrder ? first._id : messageId,
        attempt: 0,
        step: 0,
        slotId: messageId,
      });
      turn = (await ctx.db.get("turns", turnId))!;
    }
    assert(
      turn.threadId === threadId,
      `Message ${messageId} is not in thread ${threadId}`,
    );
    if (turn.end) return ended(turn.error);
    if (turn.leaseUntil !== undefined && turn.leaseUntil > Date.now()) {
      return busy(turn);
    }
    const checked = await check(ctx, turn);
    if (checked.error) return stop(ctx, turn, checked.error, checked.slot);
    let slot: Pick<Doc<"messages">, "_id" | "stepOrder">;
    if (checked.slot) {
      slot = checked.slot;
    } else {
      // The last save waited on answers. Where the slot goes is a placement
      // read, not a permission.
      const { messages } = await addMessagesHandler(ctx, {
        threadId,
        order: turn.order,
        messages: [
          { message: { role: "assistant", content: [] }, status: "pending" },
        ],
      });
      slot = {
        _id: messages[0]._id as Id<"messages">,
        stepOrder: messages[0].stepOrder,
      };
    }
    const attempt = turn.attempt + 1;
    await ctx.db.patch("turns", turn._id, {
      attempt,
      leaseUntil: Date.now() + LEASE,
      slotId: slot._id,
      error: undefined,
    });
    return {
      turnId: turn._id,
      attempt,
      step: turn.step,
      order: turn.order,
      slotId: slot._id,
      stepOrder: slot.stepOrder,
      anchorId: turn.anchorId,
      takeover: turn.leaseUntil !== undefined,
    };
  },
});

const saveArgs = omit(addMessagesArgs, [
  "order",
  "pendingMessageId",
  "failPendingSteps",
  "promptMessageId",
  "abandonIfPromptMissing",
]);

export const saveStep = mutation({
  args: {
    turnId: v.id("turns"),
    attempt: v.number(),
    step: v.number(),
    // The AI SDK continues past this step iff this is false.
    final: v.boolean(),
    ...saveArgs,
  },
  returns: v.union(v.object({ refused: vRefusal }), v.null()),
  handler: async (ctx, { turnId, attempt, step, final, ...save }) => {
    const turn = await ctx.db.get("turns", turnId);
    if (!turn || turn.end) return ended(turn?.error);
    if (
      turn.attempt !== attempt ||
      turn.step !== step ||
      turn.leaseUntil === undefined ||
      turn.leaseUntil <= Date.now()
    ) {
      return busy(turn);
    }
    assert(turn.slotId, "A turn under lease has a slot");
    assert(save.threadId === turn.threadId, "The save is in another thread");
    const last = save.messages.at(-1);
    assert(
      final === (last?.status !== "pending"),
      "Only a step the AI SDK continues past ends with a pending message",
    );
    const checked = await check(ctx, turn);
    if (checked.error) return stop(ctx, turn, checked.error, checked.slot);
    const saved = await addMessagesHandler(
      ctx,
      {
        ...save,
        promptMessageId:
          turn.anchorId !== turn.messageId ? turn.anchorId : undefined,
        pendingMessageId: turn.slotId,
        failPendingSteps: false,
      },
      turn.order,
    );
    const next = saved.messages.at(-1);
    // Throwing rolls the save back: the turn moves only on a full write.
    assert(
      saved.messages.length === save.messages.length &&
        saved.messages[0]._id === turn.slotId &&
        saved.messages.every(
          (m, i) =>
            m.order === turn.order &&
            m.status === (save.messages[i].status ?? "success"),
        ),
      "The step was not saved into the turn's slot",
    );
    await ctx.db.patch(
      "turns",
      turn._id,
      final
        ? {
            step: step + 1,
            slotId: undefined,
            leaseUntil: undefined,
            ...(!waitsForAnswers(save.messages) && {
              end: "answered" as const,
            }),
          }
        : { step: step + 1, slotId: next!._id as Id<"messages"> },
    );
    return null;
  },
});

export const fail = mutation({
  args: {
    turnId: v.id("turns"),
    attempt: v.number(),
    error: v.string(),
    // The client sends "release" only if no tool started since its last
    // committed save, so a release never lets unsaved work run twice.
    then: v.union(v.literal("release"), v.literal("hold"), v.literal("stop")),
  },
  returns: v.null(),
  handler: async (ctx, { turnId, attempt, error, then }) => {
    const turn = await ctx.db.get("turns", turnId);
    if (
      !turn ||
      turn.attempt !== attempt ||
      turn.end ||
      turn.leaseUntil === undefined ||
      turn.leaseUntil <= Date.now()
    ) {
      return null;
    }
    if (then === "stop") {
      await stop(ctx, turn, error);
    } else {
      await ctx.db.patch("turns", turnId, {
        error,
        ...(then === "release" && { leaseUntil: undefined }),
      });
    }
    return null;
  },
});

/** A tool call with no result, or an approval request with no response. */
function waitsForAnswers(messages: MessageWithMetadataInternal[]) {
  const open = new Set<string>();
  const parts = messages.flatMap(({ message }) =>
    typeof message.content === "string"
      ? []
      : (message.content as MessageContentParts[]),
  );
  for (const part of parts) {
    if (part.type === "tool-call") open.add(`call:${part.toolCallId}`);
    if (part.type === "tool-approval-request") {
      open.add(`approval:${part.approvalId}`);
    }
  }
  for (const part of parts) {
    if (part.type === "tool-result") open.delete(`call:${part.toolCallId}`);
    if (part.type === "tool-approval-response") {
      open.delete(`approval:${part.approvalId}`);
    }
  }
  return open.size > 0;
}
