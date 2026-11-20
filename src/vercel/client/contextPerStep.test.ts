import { describe, expect, test } from "vitest";
import { stepCountIs } from "ai";
import { v } from "convex/values";
import { z } from "zod/v4";
import { Agent, createThread, createTool, listMessages } from "../index.js";
import { app, components } from "./setup.test.js";
import { MockLanguageModel } from "./mockModel.js";

// A tool changes app state in step 0. The context message describes that
// state. In step 1 the model must see the new state after its own tool call
// and result, and must not see the state from before the call.

type PromptLine = { role: string; text: string };

function promptLines(prompt: { role: string; content: unknown }[]) {
  return prompt.map(
    (m): PromptLine => ({
      role: m.role,
      text:
        typeof m.content === "string"
          ? m.content
          : (m.content as { type: string; text?: string }[])
              .map((p) => p.text ?? p.type)
              .join(""),
    }),
  );
}

function makeAgent(sets: string[], calls: number[]) {
  const model = new MockLanguageModel({
    contentSteps: [
      [
        {
          type: "tool-call",
          toolCallId: "log-1",
          toolName: "logSet",
          input: JSON.stringify({ exercise: "push-ups" }),
        },
      ],
      [{ type: "text", text: "Logged them." }],
    ],
  });
  const agent = new Agent(components.agent, {
    name: "context-per-step",
    instructions: "You log workouts.",
    languageModel: model,
    tools: {
      logSet: createTool({
        inputSchema: z.object({ exercise: z.string() }),
        execute: async (_ctx, { exercise }) => {
          sets.push(exercise);
          return "logged";
        },
      }),
    },
    stopWhen: stepCountIs(3),
    contextMessage: (_ctx, { stepNumber }) => {
      calls.push(stepNumber);
      return `Sets logged: ${sets.length ? sets.join(", ") : "none"}`;
    },
  });
  return { agent, model };
}

const run = app.action({
  args: { threadId: v.string(), stream: v.boolean() },
  handler: async (ctx, { threadId, stream }) => {
    const sets: string[] = [];
    const calls: number[] = [];
    const { agent, model } = makeAgent(sets, calls);
    const prompt = "I did some push-ups, log it";
    if (stream) {
      const result = await agent.streamText(ctx, { threadId }, { prompt });
      await result.consumeStream();
      await result.text;
    } else {
      await agent.generateText(ctx, { threadId }, { prompt });
    }
    const prompts = (stream ? model.doStreamCalls : model.doGenerateCalls).map(
      (c) => promptLines(c.prompt as { role: string; content: unknown }[]),
    );
    return { prompts, calls };
  },
});

const { api, createTest } = app.defineModules({ contextPerStep: { run } });

describe("contextMessage is rebuilt before each step", () => {
  for (const stream of [false, true]) {
    test(`${stream ? "streamText" : "generateText"} sends fresh state after the tool result`, async () => {
      const t = createTest();
      const threadId = await t.run((ctx) =>
        createThread(ctx, components.agent, { userId: "ada" }),
      );
      const { prompts, calls } = await t.action(api.contextPerStep.run, {
        threadId,
        stream,
      });
      expect(calls).toEqual([0, 1]);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toEqual([
        { role: "system", text: "You log workouts." },
        { role: "user", text: "I did some push-ups, log it" },
        { role: "user", text: "Sets logged: none" },
      ]);
      // Step 1: the old state is gone, and the new state comes after the
      // model's own tool call and its result.
      expect(prompts[1].map((m) => m.role)).toEqual([
        "system",
        "user",
        "assistant",
        "tool",
        "user",
      ]);
      expect(prompts[1].at(-1)).toEqual({
        role: "user",
        text: "Sets logged: push-ups",
      });
      expect(prompts[1].map((m) => m.text)).not.toContain("Sets logged: none");

      const saved = await t.run((ctx) =>
        listMessages(ctx, components.agent, {
          threadId,
          paginationOpts: { cursor: null, numItems: 20 },
        }),
      );
      expect(saved.page.some((m) => m.text?.startsWith("Sets logged"))).toBe(
        false,
      );
    });
  }
});
