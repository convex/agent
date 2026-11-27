import { stepCountIs, tool } from "ai";
import { expect, test } from "vitest";
import { z } from "zod/v4";
import { Agent, createThread } from "../index.js";
import { MockLanguageModel } from "./mockModel.js";
import { components, initConvexTest } from "./setup.test.js";

test("a plain generation at a prompt that already has an answer keeps its own step budget", async () => {
  const model = new MockLanguageModel({
    contentSteps: [
      [{ type: "tool-call", toolCallId: "c", toolName: "lookup", input: "{}" }],
      [{ type: "text", text: "new answer" }],
    ],
  });
  const agent = new Agent(components.agent, {
    name: "plain",
    languageModel: model,
    tools: {
      lookup: tool({ inputSchema: z.object({}), execute: async () => "found" }),
    },
    stopWhen: stepCountIs(2),
  });
  const text = await initConvexTest().action(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, {});
    const { messageId } = await agent.saveMessage(ctx, {
      threadId,
      prompt: "Go.",
    });
    await agent.saveMessage(ctx, {
      threadId,
      promptMessageId: messageId,
      message: { role: "assistant", content: "old answer" },
    });
    return (
      await agent.generateText(
        ctx,
        { threadId },
        { promptMessageId: messageId },
      )
    ).text;
  });
  expect([text, model.doGenerateCalls.length]).toEqual(["new answer", 2]);
});
