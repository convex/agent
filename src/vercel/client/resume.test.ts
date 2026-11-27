import { stepCountIs, tool, type StopCondition, type ToolSet } from "ai";
import { expect, test } from "vitest";
import { z } from "zod/v4";
import { Agent, createThread } from "../index.js";
import { MockLanguageModel } from "./mockModel.js";
import { components, initConvexTest } from "./setup.test.js";

const call = (id: string) => [
  {
    type: "tool-call" as const,
    toolCallId: id,
    toolName: "lookup",
    input: "{}",
  },
];
const agent = new Agent(components.agent, {
  name: "resume",
  languageModel: new MockLanguageModel({}),
  tools: {
    lookup: tool({ inputSchema: z.object({}), execute: async () => "found" }),
  },
});

// A generation at a prompt whose first step was saved before it stopped.
async function resumed(stopWhen: StopCondition<ToolSet>) {
  const t = initConvexTest();
  const model = new MockLanguageModel({
    contentSteps: [call("c2"), call("c3"), call("c4")],
  });
  await t.action(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, {});
    const { messageId } = await agent.saveMessage(ctx, {
      threadId,
      prompt: "Go.",
    });
    await agent.saveMessages(ctx, {
      threadId,
      promptMessageId: messageId,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "lookup",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "lookup",
              output: { type: "error-text", value: "broke" },
            },
          ],
        },
      ],
      metadata: [
        { usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
        {},
      ],
    });
    await agent.generateText(
      ctx,
      { threadId },
      { promptMessageId: messageId, model, stopWhen },
    );
  });
  return model;
}

test("a generation at a prompt counts the steps saved after it toward stopWhen", async () => {
  const model = await resumed(stepCountIs(3));
  expect(model.doGenerateCalls).toHaveLength(2);
});

test("a generation's stop conditions see the saved steps' usage and tool errors", async () => {
  const seen: unknown[] = [];
  await resumed(({ steps }) => {
    seen.push(
      steps.map((step) => [
        step.usage.totalTokens,
        step.content.map((part) => part.type),
      ]),
    );
    return steps.length >= 2;
  });
  expect(seen).toEqual([
    [
      [2, ["tool-call", "tool-error"]],
      [expect.any(Number), ["tool-call", "tool-result"]],
    ],
  ]);
});
