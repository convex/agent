// See the docs at https://docs.convex.dev/agents/rate-limiting
import { v } from "convex/values";
import { getAuthUserId } from "../utils";
import { query, QueryCtx } from "../_generated/server";
import { listMessages } from "@convex-dev/agent";
import { components } from "../_generated/api";
import { rateLimiter } from "./rateLimiting";
import { DataModel } from "../_generated/dataModel";

// This allows us to have a reactive query on the client for when we can send
// the next message.
export const { getRateLimit, getServerTime } = rateLimiter.hookAPI<DataModel>(
  "sendMessage",
  { key: (ctx) => getAuthUserId(ctx) },
);

// Used to show the client know what its usage was.
export const getPreviousUsage = query({
  args: { threadId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // Get usage not accounting for the new question. Do that client-side.
    return estimateTokens(ctx, args.threadId, "");
  },
});

// This is a rough estimate of the tokens that will be used.
// It's not perfect, but it's a good enough estimate for a pre-generation check.
export async function estimateTokens(
  ctx: QueryCtx,
  threadId: string | undefined,
  question: string,
) {
  // Assume roughly 4 characters per token
  const promptTokens = question.length / 4;
  // Assume a longer non-zero reply
  const estimatedOutputTokens = promptTokens * 3 + 1;
  const latestMessages = threadId
    ? (
        await listMessages(ctx, components.agent, {
          threadId,
          paginationOpts: { cursor: null, numItems: 2 },
        })
      ).page
    : [];
  // Our new usage will roughly be the previous tokens + the question.
  // The previous tokens include the tokens for the full message history and
  // output tokens, which will be part of our new history.
  // Note:
  // - It over-counts if the history is longer than the context message
  //   limit, since some messages for the previous prompt won't be included.
  // - It doesn't account for the output tokens.
  const lastUsageMessage = latestMessages.find((message) => message.usage);
  const lastPromptTokens = lastUsageMessage?.usage?.totalTokens ?? 1;
  return lastPromptTokens + promptTokens + estimatedOutputTokens;
}
