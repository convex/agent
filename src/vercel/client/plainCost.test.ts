import { describe, expect, test } from "vitest";
import { MockEmbeddingModelV4 } from "ai/test";
import { Agent } from "../index.js";
import { measure, scriptedAgent, type Cost } from "./costMeter.test.utils.js";
import { components, initConvexTest } from "./setup.test.js";

type Plain = {
  steps: number;
  input:
    | "prompt"
    | "promptMessageId"
    | "none"
    | "a message"
    | "the pending message's prompt";
  stream?: boolean;
  /** An earlier generation's pending message that never got an answer. */
  afterPending?: boolean;
  /** A new prompt is saved while the model answers. */
  promptWhileAnswering?: boolean;
};

async function plainGeneration({
  steps,
  input,
  stream,
  afterPending,
  promptWhileAnswering,
}: Plain) {
  let prompt: (() => Promise<void>) | undefined;
  const agent = scriptedAgent(
    steps,
    "send",
    () => prompt?.() ?? Promise.resolve(),
  );
  const t = initConvexTest();
  return t.action(async (ctx) => {
    const { threadId } = await agent.createThread(ctx, {});
    if (promptWhileAnswering) {
      prompt = async () => {
        prompt = undefined;
        await agent.saveMessage(ctx, { threadId, prompt: "meanwhile" });
      };
    }
    let earlier: string | undefined;
    if (afterPending) {
      ({ messageId: earlier } = await agent.saveMessage(ctx, {
        threadId,
        prompt: "earlier",
      }));
      await agent.saveMessage(ctx, {
        threadId,
        promptMessageId: earlier,
        message: { role: "assistant", content: [] },
        metadata: { status: "pending" },
      });
    }
    const promptMessageId =
      input === "promptMessageId"
        ? (await agent.saveMessage(ctx, { threadId, prompt: "go" })).messageId
        : input === "the pending message's prompt"
          ? earlier
          : undefined;
    const args =
      input === "none"
        ? {}
        : input === "a message"
          ? { messages: [{ role: "assistant" as const, content: "A note" }] }
          : promptMessageId
            ? { promptMessageId }
            : { prompt: "go" };
    return measure(ctx, async (ctx) => {
      if (stream) {
        // Deltas written at step boundaries only, so the counts don't
        // depend on how fast the test machine is.
        const result = await agent.streamText(ctx, { threadId }, args, {
          saveStreamDeltas: { throttleMs: 60_000 },
        });
        await result.consumeStream();
        expect(await result.text).toBe("done");
      } else {
        const result = await agent.generateText(ctx, { threadId }, args);
        expect(result.text).toBe("done");
      }
    });
  });
}

const snapshot = (name: string) =>
  `./__snapshots__/plainCost/${name.replace(/[^a-z0-9]+/gi, "-")}.json`;

// Pinned on 97580c2d (https://github.com/convex/agent/pull/449), with this
// file unchanged: a plain generation and the by-id writers must read, write
// and call exactly what they did there, in the same order.
describe("a plain generation costs what it does without durable turns", () => {
  test.each<[string, Plain]>([
    ["text only", { steps: 0, input: "prompt" }],
    ["text only, promptMessageId", { steps: 0, input: "promptMessageId" }],
    ["1 side-effecting step", { steps: 1, input: "prompt" }],
    ["5 side-effecting steps", { steps: 5, input: "prompt" }],
    [
      "5 side-effecting steps, promptMessageId",
      { steps: 5, input: "promptMessageId" },
    ],
    ["text only, streamed", { steps: 0, input: "prompt", stream: true }],
    [
      "text only, after an unanswered pending message",
      { steps: 0, input: "prompt", afterPending: true },
    ],
    [
      "text only, no input, after an unanswered pending message",
      { steps: 0, input: "none", afterPending: true },
    ],
    [
      "text only, an assistant input, after an unanswered pending message",
      { steps: 0, input: "a message", afterPending: true },
    ],
    [
      "5 side-effecting steps, streamed",
      { steps: 5, input: "prompt", stream: true },
    ],
    [
      "text only, no input, a prompt saved while answering",
      {
        steps: 0,
        input: "none",
        afterPending: true,
        promptWhileAnswering: true,
      },
    ],
    [
      "1 side-effecting step, after an unanswered pending message, a prompt saved while answering",
      {
        steps: 1,
        input: "prompt",
        afterPending: true,
        promptWhileAnswering: true,
      },
    ],
    [
      "text only, the prompt of an unanswered pending message",
      { steps: 0, input: "the pending message's prompt", afterPending: true },
    ],
  ])("%s", async (name, plain) => {
    const measured = await plainGeneration(plain);
    await expect(JSON.stringify(measured, null, 1)).toMatchFileSnapshot(
      snapshot(name),
    );
  });

  test("an approval, its answer and the continuation", async () => {
    const agent = scriptedAgent(1, "ask");
    const t = initConvexTest();
    const measured = await t.action(async (ctx) => {
      const { threadId } = await agent.createThread(ctx, {});
      const asked = await measure(ctx, (ctx) =>
        agent.generateText(ctx, { threadId }, { prompt: "go" }),
      );
      const request = (
        await agent.listMessages(ctx, {
          threadId,
          paginationOpts: { cursor: null, numItems: 20 },
        })
      ).page.flatMap((m) =>
        Array.isArray(m.message?.content)
          ? m.message.content.flatMap((part) =>
              part.type === "tool-approval-request" ? [part.approvalId] : [],
            )
          : [],
      );
      expect(request).toHaveLength(1);
      let messageId!: string;
      const answered = await measure(ctx, async (ctx) => {
        ({ messageId } = await agent.approveToolCall(ctx as never, {
          threadId,
          approvalId: request[0],
        }));
      });
      const continued = await measure(ctx, async (ctx) => {
        const result = await agent.generateText(
          ctx,
          { threadId },
          { promptMessageId: messageId },
        );
        expect(result.text).toBe("done");
      });
      return { asked, answered, continued };
    });
    await expect(JSON.stringify(measured, null, 1)).toMatchFileSnapshot(
      snapshot("approval"),
    );
  });

  test("saves, edits, failures and deletes by id", async () => {
    const agent = scriptedAgent(0, "send");
    const t = initConvexTest();
    const measured = await t.action(async (ctx) => {
      const { threadId } = await agent.createThread(ctx, {});
      const results: Record<string, Cost> = {};
      let prompt!: string;
      let pending!: string;
      results.saveMessage = await measure(ctx, async (ctx) => {
        ({ messageId: prompt } = await agent.saveMessage(ctx, {
          threadId,
          prompt: "hi",
        }));
      });
      results.savePending = await measure(ctx, async (ctx) => {
        ({ messageId: pending } = await agent.saveMessage(ctx, {
          threadId,
          promptMessageId: prompt,
          message: { role: "assistant", content: [] },
          metadata: { status: "pending" },
        }));
      });
      results.saveIntoPending = await measure(ctx, async (ctx) => {
        await agent.saveMessage(ctx, {
          threadId,
          pendingMessageId: pending,
          message: { role: "assistant", content: "filled" },
        });
      });
      results.updateMessage = await measure(ctx, async (ctx) => {
        await agent.updateMessage(ctx, {
          messageId: pending,
          patch: {
            message: { role: "assistant", content: "edited" },
            status: "success",
          },
        });
      });
      const { messageId: failing } = await agent.saveMessage(ctx, {
        threadId,
        promptMessageId: prompt,
        message: { role: "assistant", content: [] },
        metadata: { status: "pending" },
      });
      results.finalizeFailed = await measure(ctx, async (ctx) => {
        await agent.finalizeMessage(ctx, {
          messageId: failing,
          result: { status: "failed", error: "nope" },
        });
      });
      results.deleteByIds = await measure(ctx, async (ctx) => {
        await agent.deleteMessages(ctx, { messageIds: [failing] });
      });
      results.saveAtOrder = await measure(ctx, async (ctx) => {
        await agent.saveMessages(ctx, {
          threadId,
          messages: [{ role: "assistant", content: "at order 0" }],
          order: 0,
        } as never);
      });
      results.deleteByOrder = await measure(ctx, async (ctx) => {
        await agent.deleteMessageRange(ctx, {
          threadId,
          startOrder: 0,
          endOrder: 1,
        });
      });
      return results;
    });
    await expect(JSON.stringify(measured, null, 1)).toMatchFileSnapshot(
      snapshot("by id"),
    );
  });

  test("a prompt saved without an embedding, embedded when generated from", async () => {
    const base = scriptedAgent(0, "send");
    const agent = new Agent(components.agent, {
      ...base.options,
      embeddingModel: new MockEmbeddingModelV4({
        modelId: "embed",
        maxEmbeddingsPerCall: 10,
        doEmbed: async ({ values }) => ({
          embeddings: values.map(() => Array.from({ length: 128 }, () => 0.5)),
          warnings: [],
        }),
      }),
    });
    const t = initConvexTest();
    const measured = await t.action(async (ctx) => {
      const { threadId } = await agent.createThread(ctx, {});
      const { messageId } = await agent.saveMessage(ctx, {
        threadId,
        prompt: "go",
        skipEmbeddings: true,
      });
      return measure(ctx, async (ctx) => {
        const result = await agent.generateText(
          ctx,
          { threadId },
          { promptMessageId: messageId },
        );
        expect(result.text).toBe("done");
      });
    });
    await expect(JSON.stringify(measured, null, 1)).toMatchFileSnapshot(
      snapshot("lazy embedding"),
    );
  });

  test("a thread copied and deleted", async () => {
    const agent = scriptedAgent(1, "send");
    const t = initConvexTest();
    const measured = await t.action(async (ctx) => {
      const { threadId } = await agent.createThread(ctx, {});
      await agent.generateText(ctx, { threadId }, { prompt: "go" });
      const { threadId: copy } = await agent.createThread(ctx, {});
      const cloned = await measure(ctx, async (ctx) => {
        await ctx.runAction(components.agent.messages.cloneThread, {
          sourceThreadId: threadId,
          targetThreadId: copy,
        });
      });
      const deleted = await measure(ctx, async (ctx) => {
        await agent.deleteThreadSync(ctx, { threadId: copy });
      });
      return { cloned, deleted };
    });
    await expect(JSON.stringify(measured, null, 1)).toMatchFileSnapshot(
      snapshot("clone and delete"),
    );
  });

  test("a user's threads deleted", async () => {
    const agent = scriptedAgent(1, "send");
    const t = initConvexTest();
    const measured = await t.action(async (ctx) => {
      const { threadId } = await agent.createThread(ctx, { userId: "u" });
      await agent.generateText(ctx, { threadId }, { prompt: "go" });
      return measure(ctx, async (ctx) => {
        await ctx.runAction(components.agent.users.deleteAllForUserId, {
          userId: "u",
        });
      });
    });
    await expect(JSON.stringify(measured, null, 1)).toMatchFileSnapshot(
      snapshot("user deletion"),
    );
  });

  // Deletion reads turns once per thread, on the page its messages finish.
  test.each(["deleteAllForUserId", "deleteAllForThreadIdSync"] as const)(
    "%s over two message pages reads turns once",
    async (by) => {
      const agent = scriptedAgent(0, "send");
      const t = initConvexTest();
      const measured = await t.action(async (ctx) => {
        const { threadId } = await agent.createThread(ctx, { userId: "u" });
        await agent.saveMessages(ctx, {
          threadId,
          messages: Array.from({ length: 101 }, (_, i) => ({
            role: "user" as const,
            content: `${i}`,
          })),
        });
        return measure(ctx, async (ctx) => {
          if (by === "deleteAllForUserId") {
            await ctx.runAction(components.agent.users.deleteAllForUserId, {
              userId: "u",
            });
          } else {
            await ctx.runAction(
              components.agent.threads.deleteAllForThreadIdSync,
              { threadId },
            );
          }
        });
      });
      const calls = measured.calls.join("\n");
      expect(
        calls.match(/page threadId_status_tool_order_stepOrder/g),
      ).toHaveLength(2);
      expect(calls.match(/q threadId\(/g)).toHaveLength(1);
    },
  );
});
