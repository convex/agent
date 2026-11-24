// See the docs at https://docs.convex.dev/agents/rag
import { createTool, stepCountIs } from "@convex-dev/agent";
import { RAG } from "@convex-dev/rag";
import { v } from "convex/values";
import { z } from "zod/v3";
import { components, internal } from "../_generated/api";
import { action } from "../_generated/server";
import { agent } from "../agents/simple";
import { getAuthUserId } from "../utils";
import { embeddingModel } from "../modelsForDemo";

const rag = new RAG(components.rag, {
  textEmbeddingModel: embeddingModel,
  embeddingDimension: 1536,
});

export const sendMessage = action({
  args: { threadId: v.string(), prompt: v.string() },
  handler: async (ctx, { threadId, prompt }) => {
    const userId = await getAuthUserId(ctx);
    const { messageId: promptMessageId } = await agent.saveMessage(ctx, {
      threadId,
      prompt,
    });
    await agent.generateText(
      ctx,
      { threadId },
      {
        promptMessageId,
        stopWhen: stepCountIs(3),
        tools: {
          addContext: createTool({
            description: "Store information to search later via RAG",
            inputSchema: z.object({
              title: z.string().describe("The title of the context"),
              text: z.string().describe("The text body of the context"),
            }),
            execute: async (ctx, input) => {
              await rag.add(ctx, {
                namespace: userId,
                title: input.title,
                text: input.text,
              });
            },
          }),
          searchContext: createTool({
            description: "Search for context related to this user prompt",
            inputSchema: z.object({
              query: z
                .string()
                .describe("Describe the context you're looking for"),
            }),
            execute: async (ctx, input) => {
              const context = await rag.search(ctx, {
                namespace: userId,
                query: input.query,
                limit: 5,
              });
              // To show the context in the demo UI, we record the context used
              await ctx.runMutation(internal.rag.utils.recordContextUsed, {
                messageId: promptMessageId,
                entries: context.entries,
                results: context.results,
              });
              return (
                `Found results in ${context.entries
                  .map((e) => e.title || null)
                  .filter((t) => t !== null)
                  .join(", ")}` + `Here is the context:\n\n ${context.text}`
              );
            },
          }),
        },
      },
    );
  },
});
