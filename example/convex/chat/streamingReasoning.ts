// See the docs at https://docs.convex.dev/agents/messages
import { Agent, createThread } from "@convex-dev/agent";
import { components } from "../_generated/api";
import { action } from "../_generated/server";
import { v } from "convex/values";
import { authorizeThreadAccess } from "../threads";
import { storyAgent } from "../agents/story";
import { stepCountIs, tool, toUIMessageStream } from "ai";
import { groq } from "@ai-sdk/groq";
import z from "zod/v3";
import { defaultConfig } from "../agents/config";

const reasoningModel = groq("qwen/qwen3-32b");

const streamingReasoningAgent = new Agent(components.agent, {
  name: "Streaming Reasoning Agent",
  instructions: "Think about the question and answer it.",
  ...defaultConfig,
  stopWhen: stepCountIs(3),
  languageModel: reasoningModel,
});

export const streamReasoning = action({
  args: {},
  handler: async (ctx, _args) => {
    const threadId = await createThread(ctx, components.agent, {
      title: "Streaming Reasoning",
    });
    const result = await streamingReasoningAgent.streamText(
      ctx,
      { threadId },
      {
        prompt: "What is the best flavor of ice cream?",
        providerOptions: {
          groq: {
            reasoningEffort: "default",
            reasoningFormat: "parsed",
            // parallelToolCalls: true, // Enable parallel function calling (default: true)
            // user: 'user-123', // Unique identifier for end-user (optional)
          },
        },
        tools: {
          say: tool({
            description: "Ask a friend for their favorite flavor of ice cream",
            inputSchema: z.object({
              question: z.string().describe("The question to ask the friend"),
            }),
            execute: async ({ question }) => {
              console.log("asking a friend", question);
              return "I'm sorry I can't help you. Stop asking me questions.";
            },
          }),
        },
      },
      { saveStreamDeltas: { chunking: "line" } },
    );
    for await (const chunk of toUIMessageStream({ stream: result.stream })) {
      console.log(chunk);
    }
  },
});

/**
 * OPTION 1:
 * Stream the response in a single action call.
 */

export const streamOneShot = action({
  args: { prompt: v.string(), threadId: v.string() },
  handler: async (ctx, { prompt, threadId }) => {
    await authorizeThreadAccess(ctx, threadId);
    const result = await storyAgent.streamText(
      ctx,
      { threadId },
      { prompt },
      { saveStreamDeltas: true },
    );
    // We don't need to return anything, as the response is saved as deltas
    // in the database and clients are subscribed to the stream.

    // We do need to make sure the stream is finished - by awaiting each chunk
    // or using this call to consume it all.
    await result.consumeStream();
  },
});
