import { describe, expect, test } from "vitest";
import { stepCountIs } from "ai";
import { v } from "convex/values";
import { z } from "zod/v4";
import { Agent, createThread, createTool, listMessages } from "../index.js";
import { app, components } from "./setup.test.js";
import { MockLanguageModel } from "./mockModel.js";

// With promptCache, each model call carries two Anthropic cache breakpoints:
// one on the instructions and one on the last message before the context
// message. On a later step the second one moves to the newest tool result.

type Line = { role: string; cached: boolean };

function lines(prompt: { role: string; providerOptions?: unknown }[]): Line[] {
  return prompt.map((m) => ({
    role: m.role,
    cached: Boolean(
      (m.providerOptions as { anthropic?: { cacheControl?: unknown } })
        ?.anthropic?.cacheControl,
    ),
  }));
}

function makeAgent(withContext: boolean) {
  const model = new MockLanguageModel({
    contentSteps: [
      [
        {
          type: "tool-call",
          toolCallId: "look-1",
          toolName: "lookup",
          input: JSON.stringify({ q: "plank" }),
        },
      ],
      [{ type: "text", text: "Done." }],
    ],
  });
  const agent = new Agent(components.agent, {
    name: "prompt-cache",
    instructions: "You log workouts.",
    languageModel: model,
    promptCache: true,
    tools: {
      lookup: createTool({
        inputSchema: z.object({ q: z.string() }),
        execute: async () => "found",
      }),
    },
    stopWhen: stepCountIs(3),
    ...(withContext
      ? {
          contextMessage: (
            _ctx: unknown,
            { stepNumber }: { stepNumber: number },
          ) => `State at step ${stepNumber}`,
        }
      : {}),
  });
  return { agent, model };
}

const run = app.action({
  args: {
    threadId: v.string(),
    stream: v.boolean(),
    withContext: v.boolean(),
  },
  handler: async (ctx, { threadId, stream, withContext }) => {
    const { agent, model } = makeAgent(withContext);
    if (stream) {
      const result = await agent.streamText(
        ctx,
        { threadId },
        { prompt: "look up plank" },
      );
      await result.consumeStream();
      await result.text;
    } else {
      await agent.generateText(ctx, { threadId }, { prompt: "look up plank" });
    }
    return (stream ? model.doStreamCalls : model.doGenerateCalls).map((c) =>
      lines(c.prompt as { role: string; providerOptions?: unknown }[]),
    );
  },
});

const { api, createTest } = app.defineModules({ promptCache: { run } });

describe("promptCache", () => {
  for (const stream of [false, true]) {
    test(`${stream ? "streamText" : "generateText"} moves the history breakpoint to the newest message each step`, async () => {
      const t = createTest();
      const threadId = await t.run((ctx) =>
        createThread(ctx, components.agent, { userId: "ada" }),
      );
      const prompts = await t.action(api.promptCache.run, {
        threadId,
        stream,
        withContext: true,
      });
      expect(prompts).toEqual([
        [
          { role: "system", cached: true },
          { role: "user", cached: true },
          { role: "user", cached: false }, // context message
        ],
        [
          { role: "system", cached: true },
          { role: "user", cached: false },
          { role: "assistant", cached: false },
          { role: "tool", cached: true },
          { role: "user", cached: false }, // context message
        ],
      ]);
    });
  }

  test("without a context message the last message carries the breakpoint", async () => {
    const t = createTest();
    const threadId = await t.run((ctx) =>
      createThread(ctx, components.agent, { userId: "ada" }),
    );
    const prompts = await t.action(api.promptCache.run, {
      threadId,
      stream: false,
      withContext: false,
    });
    expect(prompts[1]).toEqual([
      { role: "system", cached: true },
      { role: "user", cached: false },
      { role: "assistant", cached: false },
      { role: "tool", cached: true },
    ]);
    // The marker is only sent, never saved.
    const saved = await t.run((ctx) =>
      listMessages(ctx, components.agent, {
        threadId,
        paginationOpts: { cursor: null, numItems: 20 },
      }),
    );
    for (const m of saved.page) {
      expect(JSON.stringify(m.message ?? {})).not.toContain("cacheControl");
    }
  });
});
