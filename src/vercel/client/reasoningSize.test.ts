import { describe, expect, test } from "vitest";
import { getDocumentSize } from "convex/values";
import { Agent, createThread, toUIMessages } from "../index.js";
import { mockModel } from "./mockModel.js";
import { initConvexTest } from "../../component/setup.test.js";
import { api } from "../../component/_generated/api.js";
import type { ComponentApi } from "../../component/_generated/component.js";

// The component runs as the root app here so the test can read stored rows.
const component = api as unknown as ComponentApi;
// Spaces every 10KB keep the mock's per-word stream chunks few and large.
const LONG = Array.from({ length: 4 }, () => "r".repeat(10_000)).join(" ");
const SIGNED = { mock: { signature: "sig-123" } };

type T = ReturnType<typeof initConvexTest>;

const agentWith = (options: Parameters<typeof mockModel>[0]) =>
  new Agent(component, {
    name: "reasoning",
    languageModel: mockModel(options),
  });

async function storedAssistant(t: T) {
  const docs = (
    await t.run((ctx) => ctx.db.query("messages").collect())
  ).filter((doc) => doc.message?.role === "assistant");
  expect(docs).toHaveLength(1);
  expect(getDocumentSize(docs[0])).toBeLessThan(LONG.length * 1.5);
  return docs[0];
}

async function readAssistant(t: T, threadId: string) {
  const { page } = await t.run((ctx) =>
    agentWith({}).listMessages(ctx, {
      threadId,
      paginationOpts: { cursor: null, numItems: 10 },
    }),
  );
  const assistants = page.filter((m) => m.message?.role === "assistant");
  expect(assistants).toHaveLength(1);
  return assistants[0];
}

describe("step reasoning is stored once and derived on read (#418)", () => {
  test.each(["generateText", "streamText"] as const)("%s", async (how) => {
    const t = initConvexTest();
    const agent = agentWith({
      content: [
        { type: "reasoning", text: LONG, providerMetadata: SIGNED },
        { type: "reasoning", text: "tail" },
        { type: "text", text: "done" },
      ],
    });
    const { threadId, step } = await t.action(async (ctx) => {
      const threadId = await createThread(ctx, component, {});
      if (how === "generateText") {
        const result = await agent.generateText(
          ctx,
          { threadId },
          { prompt: "think" },
        );
        const [{ reasoningText, reasoning }] = result.steps;
        return { threadId, step: { reasoningText, reasoning } };
      }
      const result = await agent.streamText(
        ctx,
        { threadId },
        { prompt: "think" },
        { saveStreamDeltas: { chunking: "word", throttleMs: 0 } },
      );
      await result.consumeStream();
      const [{ reasoningText, reasoning }] = await result.steps;
      return { threadId, step: { reasoningText, reasoning } };
    });
    await storedAssistant(t);
    const assistant = await readAssistant(t, threadId);
    expect(assistant.reasoning).toBe(step.reasoningText);
    expect(assistant.reasoningDetails).toEqual(step.reasoning);
    expect(step.reasoning[0]).toMatchObject({ providerOptions: SIGNED });
    const [ui] = toUIMessages([assistant]);
    expect(ui.parts.filter((p) => p.type === "reasoning")).toHaveLength(2);
  });

  test("a failed stream saves its reasoning once", async () => {
    const t = initConvexTest();
    const agent = agentWith({
      content: [{ type: "reasoning", text: LONG }],
      fail: { error: "provider failed" },
    });
    const threadId = await t.action(async (ctx) => {
      const threadId = await createThread(ctx, component, {});
      const result = await agent.streamText(
        ctx,
        { threadId },
        { prompt: "think" },
        { saveStreamDeltas: { chunking: "word", throttleMs: 0 } },
      );
      await result.consumeStream();
      return threadId;
    });
    await t.finishAllScheduledFunctions(() => {});
    expect((await storedAssistant(t)).status).toBe("failed");
    expect((await readAssistant(t, threadId)).reasoning).toBe(LONG);
  });

  test("documents that stored the top-level fields keep them", async () => {
    const t = initConvexTest();
    const threadId = await t.action((ctx) => createThread(ctx, component, {}));
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        threadId: ctx.db.normalizeId("threads", threadId)!,
        order: 0,
        stepOrder: 0,
        status: "success",
        tool: false,
        message: {
          role: "assistant",
          content: [{ type: "reasoning", text: "from content" }],
        },
        reasoning: "stored",
        reasoningDetails: [{ type: "text", text: "stored" }],
      });
    });
    const assistant = await readAssistant(t, threadId);
    expect(assistant.reasoning).toBe("stored");
    expect(assistant.reasoningDetails).toEqual([
      { type: "text", text: "stored" },
    ]);
  });
});
