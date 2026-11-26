import { describe, expect, test } from "vitest";
import { createThread, saveMessages } from "@convex-dev/agent";
import { api, components } from "../_generated/api";
import { initConvexTest } from "../setup.test";

async function setup(approvalIds: string[]) {
  const t = initConvexTest();
  const threadId = await t.run(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, {});
    await saveMessages(ctx, components.agent, {
      threadId,
      messages: [
        { role: "user", content: "Delete both files" },
        {
          role: "assistant",
          content: approvalIds.flatMap((approvalId) => [
            {
              type: "tool-call" as const,
              toolCallId: `call-${approvalId}`,
              toolName: "deleteFile",
              input: { filename: `${approvalId}.txt` },
            },
            {
              type: "tool-approval-request" as const,
              toolCallId: `call-${approvalId}`,
              approvalId,
            },
          ]),
        },
      ],
    });
    return threadId;
  });
  const decide = (approvalId: string, approved = true) =>
    t.mutation(api.chat.approval.submitApproval, {
      threadId,
      approvalId,
      approved,
    });
  const scheduled = () =>
    t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).map(
        ({ name, args }) => ({ name, args }),
      ),
    );
  return { threadId, decide, scheduled };
}

const continuation = (threadId: string, promptMessageId: string) => ({
  name: "chat/approval:generateResponse",
  args: [{ threadId, promptMessageId }],
});

describe("submitApproval", () => {
  test("continues once, after the last of parallel decisions", async () => {
    const { threadId, decide, scheduled } = await setup(["a", "b"]);
    await decide("a");
    expect(await scheduled()).toEqual([]);
    const { messageId } = await decide("b");
    expect(await scheduled()).toEqual([continuation(threadId, messageId)]);
  });

  test("continues when a step's decisions fill the lookup window", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `a${i}`);
    const { threadId, decide, scheduled } = await setup(ids);
    for (const id of ids.slice(0, -1)) await decide(id);
    expect(await scheduled()).toEqual([]);
    const { messageId } = await decide(ids.at(-1)!);
    expect(await scheduled()).toEqual([continuation(threadId, messageId)]);
  }, 30_000);

  test("continues after a single decision", async () => {
    const { threadId, decide, scheduled } = await setup(["a"]);
    const { messageId } = await decide("a");
    expect(await scheduled()).toEqual([continuation(threadId, messageId)]);
  });

  test("counts a denial as a decision", async () => {
    const { threadId, decide, scheduled } = await setup(["a", "b"]);
    await decide("a");
    const { messageId } = await decide("b", false);
    expect(await scheduled()).toEqual([continuation(threadId, messageId)]);
  });

  test("rejects a decision for a step that already continued", async () => {
    const { threadId, decide, scheduled } = await setup(["a"]);
    const { messageId } = await decide("a");
    await expect(decide("a", false)).rejects.toThrow(/already handled/);
    expect(await scheduled()).toEqual([continuation(threadId, messageId)]);
  });
});
