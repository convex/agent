/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import schema from "./schema.js";
import { modules } from "./setup.test.js";

const init = () => convexTest(schema, modules);
type T = ReturnType<typeof init>;
type Q = {
  threadId: Id<"threads">;
  promptId: Id<"messages">;
  key: Id<"messages">;
};

const LEASE = 15 * 60 * 1000;
const later = () => vi.setSystemTime(Date.now() + LEASE + 60_000);

afterEach(() => vi.useRealTimers());

/** A prompt and the app's pending message after it. */
async function queue(t: T, userId?: string): Promise<Q> {
  const thread = await t.mutation(api.threads.createThread, { userId });
  const threadId = thread._id as Id<"threads">;
  const { messages } = await t.mutation(api.messages.addMessages, {
    threadId,
    userId,
    messages: [
      { message: { role: "user", content: "go" } },
      { message: { role: "assistant", content: [] }, status: "pending" },
    ],
  });
  return {
    threadId,
    promptId: messages[0]._id as Id<"messages">,
    key: messages[1]._id as Id<"messages">,
  };
}

const claim = (t: T, q: Q) =>
  t.mutation(api.turns.claim, { threadId: q.threadId, messageId: q.key });

async function claimed(t: T, q: Q) {
  const turn = await claim(t, q);
  if ("refused" in turn) throw new Error(turn.refused.code);
  return turn;
}

const status = (t: T, id: Id<"messages">) =>
  t.run(async (ctx) => (await ctx.db.get("messages", id))?.status);

describe("layer 1: one attempt at a time", () => {
  test("a second claim is busy until the lease expires, then takes over", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = init();
    const q = await queue(t);
    const first = await claimed(t, q);
    const busy = await claim(t, q);
    later();
    const takeover = await claimed(t, q);
    expect(first).toMatchObject({ attempt: 1, slotId: q.key, takeover: false });
    expect(busy).toMatchObject({
      refused: { code: "TurnBusy", retryAt: expect.any(Number) },
    });
    expect(takeover).toMatchObject({
      turnId: first.turnId,
      attempt: 2,
      slotId: q.key,
      takeover: true,
    });
  });

  test("a claim of a message that is not pending in its thread throws, and starts no turn", async () => {
    const t = init();
    const q = await queue(t);
    const other = await t.mutation(api.threads.createThread, {});
    await expect(
      claim(t, { ...q, threadId: other._id as Id<"threads"> }),
    ).rejects.toThrow(/not in thread/);
    await expect(claim(t, { ...q, key: q.promptId })).rejects.toThrow(
      /not pending/,
    );
    expect(await claimed(t, q)).toMatchObject({ attempt: 1 });
  });

  test.each([
    ["release", { attempt: 2 }, "pending"],
    ["hold", { refused: { code: "TurnBusy" } }, "pending"],
    ["stop", { refused: { code: "TurnEnded", error: "boom" } }, "failed"],
  ] as const)(
    "a failure write with %s settles the next claim",
    async (then, next, keyStatus) => {
      const t = init();
      const q = await queue(t);
      const turn = await claimed(t, q);
      await t.mutation(api.turns.fail, {
        turnId: turn.turnId,
        attempt: turn.attempt,
        error: "boom",
        then,
      });
      expect(await claim(t, q)).toMatchObject(next);
      expect(await status(t, q.key)).toBe(keyStatus);
    },
  );

  test("a failure write from an expired or superseded attempt changes nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = init();
    const q = await queue(t);
    const first = await claimed(t, q);
    later();
    const expired = { turnId: first.turnId, attempt: 1, error: "late" };
    await t.mutation(api.turns.fail, { ...expired, then: "stop" });
    const second = await claimed(t, q);
    await t.mutation(api.turns.fail, { ...expired, then: "release" });
    expect(second).toMatchObject({ attempt: 2 });
    expect(await claim(t, q)).toMatchObject({ refused: { code: "TurnBusy" } });
    expect(await status(t, q.key)).toBe("pending");
  });

  test("a prompt deleted between attempts ends the turn and fails its pending message", async () => {
    const t = init();
    const q = await queue(t);
    const turn = await claimed(t, q);
    await t.mutation(api.turns.fail, {
      turnId: turn.turnId,
      attempt: turn.attempt,
      error: "provider down",
      then: "release",
    });
    await t.mutation(api.messages.deleteByIds, { messageIds: [q.promptId] });
    expect(await claim(t, q)).toMatchObject({
      refused: { code: "TurnEnded", error: expect.stringMatching(/prompt/) },
    });
    expect(await status(t, q.key)).toBe("failed");
  });

  // A turn row deleted while its pending message still exists would let a
  // retry start the turn over next to the live attempt.
  test("deleting a thread page by page leaves a running turn busy", async () => {
    const t = init();
    const q = await queue(t);
    // Deleted first: "failed" sorts before "pending" in the page's index.
    await t.mutation(api.messages.addMessages, {
      threadId: q.threadId,
      messages: [
        {
          message: { role: "assistant", content: "old" },
          status: "failed",
          error: "old",
        },
      ],
    });
    await claimed(t, q);
    await t.mutation(internal.threads._deletePageForThreadId, {
      threadId: q.threadId,
      limit: 1,
    });
    expect(await claim(t, q)).toMatchObject({ refused: { code: "TurnBusy" } });
  });

  test.each(["thread", "user"] as const)(
    "deleting the %s deletes its turns",
    async (what) => {
      const t = init();
      const q = await queue(t, "u");
      await claimed(t, q);
      if (what === "thread") {
        await t.action(api.threads.deleteAllForThreadIdSync, {
          threadId: q.threadId,
        });
      } else {
        await t.action(api.users.deleteAllForUserId, { userId: "u" });
      }
      expect(await t.run((ctx) => ctx.db.query("turns").collect())).toEqual([]);
    },
  );
});

describe("layer 1: step saves", () => {
  type Turn = Awaited<ReturnType<typeof claimed>>;
  const text = (content: string) => ({
    message: { role: "assistant" as const, content },
  });
  const pending = {
    message: { role: "assistant" as const, content: [] },
    status: "pending" as const,
  };
  const save = (
    t: T,
    q: Q,
    turn: Pick<Turn, "turnId" | "attempt" | "step">,
    final: boolean,
    messages: { message: { role: "assistant"; content: any } }[],
  ) =>
    t.mutation(api.turns.saveStep, {
      turnId: turn.turnId,
      attempt: turn.attempt,
      step: turn.step,
      final,
      threadId: q.threadId,
      messages,
    });
  const rows = (t: T, q: Q) =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query("messages")
          .withIndex("threadId_status_tool_order_stepOrder", (i) =>
            i.eq("threadId", q.threadId),
          )
          .collect()
      ).map((m) => [m._id, m.order, m.status]),
    );

  test("each step fills the turn's slot at its order, and the final one answers it", async () => {
    const t = init();
    const q = await queue(t);
    const turn = await claimed(t, q);
    const first = await save(t, q, turn, false, [text("one"), pending]);
    const busy = await claim(t, q);
    const last = await save(t, q, { ...turn, step: 1 }, true, [text("two")]);
    const saved = await rows(t, q);
    expect([first, last]).toEqual([null, null]);
    expect(busy).toMatchObject({ refused: { code: "TurnBusy" } });
    expect(await claim(t, q)).toMatchObject({ refused: { code: "TurnEnded" } });
    expect(saved.map(([, order, s]) => [order, s])).toEqual(
      Array(3).fill([turn.order, "success"]),
    );
  });

  test("a step save retried after it committed is refused and writes nothing", async () => {
    const t = init();
    const q = await queue(t);
    const turn = await claimed(t, q);
    await save(t, q, turn, false, [text("once"), pending]);
    const before = await rows(t, q);
    const again = await save(t, q, turn, false, [text("once"), pending]);
    expect(again).toMatchObject({ refused: { code: "TurnBusy" } });
    expect(await rows(t, q)).toEqual(before);
  });

  test("a save from an attempt that was taken over is refused and writes nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = init();
    const q = await queue(t);
    const zombie = await claimed(t, q);
    later();
    await claimed(t, q);
    const before = await rows(t, q);
    const late = await save(t, q, zombie, true, [text("late")]);
    expect(late).toMatchObject({ refused: { code: "TurnBusy" } });
    expect(await rows(t, q)).toEqual(before);
  });

  test("a save into a slot that already succeeded is refused before it writes", async () => {
    const t = init();
    const q = await queue(t);
    const turn = await claimed(t, q);
    await t.mutation(api.messages.finalizeMessage, {
      messageId: q.key,
      result: { status: "success" },
    });
    const before = await rows(t, q);
    const saved = await save(t, q, turn, true, [text("late")]);
    expect(saved).toMatchObject({ refused: { code: "TurnEnded" } });
    expect(await rows(t, q)).toEqual(before);
  });

  test("a final save that waits on answers leaves the turn open, and a late failure write changes nothing", async () => {
    const t = init();
    const q = await queue(t);
    const turn = await claimed(t, q);
    const call = {
      type: "tool-call" as const,
      input: {},
      toolCallId: "1",
      toolName: "note",
    };
    await save(t, q, turn, true, [
      { message: { role: "assistant", content: [call] } },
    ]);
    await t.mutation(api.turns.fail, {
      turnId: turn.turnId,
      attempt: turn.attempt,
      error: "late",
      then: "stop",
    });
    const next = await claimed(t, q);
    expect(next).toMatchObject({ attempt: 2, step: 1, order: turn.order });
    expect(next.slotId).not.toBe(q.key);
    expect(await status(t, next.slotId as Id<"messages">)).toBe("pending");
  });
});
