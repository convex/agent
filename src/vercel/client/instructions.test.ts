import { describe, expect, test } from "vitest";
import { v } from "convex/values";
import { Agent, createThread, listMessages } from "../index.js";
import { app, components } from "./setup.test.js";
import { MockLanguageModel } from "./mockModel.js";

const model = new MockLanguageModel({
  content: [{ type: "text", text: "ok" }],
});
let contextCalls: unknown[] = [];
const agent = new Agent(components.agent, {
  name: "instructions-test",
  languageModel: model,
  instructions: async (_ctx, { threadId, userId }) =>
    `You help ${userId} in ${threadId ? "a thread" : "no thread"}.`,
  contextMessage: (_ctx, args) => {
    contextCalls.push(args);
    return `State: step ${contextCalls.length}`;
  },
});

function lastPrompt() {
  return model.doGenerateCalls.at(-1)!.prompt.map((m) => ({
    role: m.role,
    text:
      typeof m.content === "string"
        ? m.content
        : m.content.map((p) => ("text" in p ? p.text : p.type)).join(""),
  }));
}

const generate = app.action({
  args: { threadId: v.string(), override: v.boolean() },
  handler: async (ctx, { threadId, override }) => {
    contextCalls = [];
    const result = await agent.generateText(
      ctx,
      { threadId },
      override
        ? {
            prompt: "hi",
            instructions: () => "Per-call instructions.",
            contextMessage: [{ role: "user", content: "Per-call context." }],
          }
        : { prompt: "hi" },
    );
    return {
      prompt: lastPrompt(),
      contextCalls,
      promptMessageId: result.promptMessageId,
    };
  },
});

const stream = app.action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    contextCalls = [];
    const result = await agent.streamText(
      ctx,
      { threadId },
      { prompt: "streamed", contextMessage: "Stream context." },
    );
    await result.consumeStream();
    return model.doStreamCalls.at(-1)!.prompt.map((m) => m.role);
  },
});

const { api, createTest } = app.defineModules({
  instructions: { generate, stream },
});

describe("instructions functions and context messages", () => {
  test("instructions and contextMessage are computed per call, and the context is not saved", async () => {
    const t = createTest();
    const threadId = await t.run((ctx) =>
      createThread(ctx, components.agent, { userId: "ada" }),
    );
    const first = await t.action(api.instructions.generate, {
      threadId,
      override: false,
    });
    expect(first.prompt).toEqual([
      { role: "system", text: "You help ada in a thread." },
      { role: "user", text: "hi" },
      { role: "user", text: "State: step 1" },
    ]);
    expect(first.contextCalls).toEqual([
      { threadId, userId: "ada", promptMessageId: first.promptMessageId },
    ]);

    // The next call's history has the saved prompt and reply, and only the
    // new context message at the end.
    const second = await t.action(api.instructions.generate, {
      threadId,
      override: false,
    });
    expect(second.prompt).toEqual([
      { role: "system", text: "You help ada in a thread." },
      { role: "user", text: "hi" },
      { role: "assistant", text: "ok" },
      { role: "user", text: "hi" },
      { role: "user", text: "State: step 1" },
    ]);

    const saved = await t.run((ctx) =>
      listMessages(ctx, components.agent, {
        threadId,
        paginationOpts: { cursor: null, numItems: 20 },
      }),
    );
    expect(saved.page.map((m) => m.text)).not.toContain("State: step 1");
    expect(saved.page).toHaveLength(4);
  });

  test("per-call instructions and contextMessage override the agent's", async () => {
    const t = createTest();
    const threadId = await t.run((ctx) =>
      createThread(ctx, components.agent, { userId: "ada" }),
    );
    const result = await t.action(api.instructions.generate, {
      threadId,
      override: true,
    });
    expect(result.prompt).toEqual([
      { role: "system", text: "Per-call instructions." },
      { role: "user", text: "hi" },
      { role: "user", text: "Per-call context." },
    ]);
    expect(result.contextCalls).toEqual([]);
  });

  test("streamText sends the context message last", async () => {
    const t = createTest();
    const threadId = await t.run((ctx) =>
      createThread(ctx, components.agent, { userId: "ada" }),
    );
    expect(await t.action(api.instructions.stream, { threadId })).toEqual([
      "system",
      "user",
      "user",
    ]);
  });
});
