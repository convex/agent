// See the docs at https://docs.convex.dev/agents/workflows
import { WorkflowId, WorkflowManager } from "@convex-dev/workflow";
import { createThread, saveMessage, stepCountIs } from "@convex-dev/agent";
import { components, internal } from "../_generated/api";
import { action, mutation } from "../_generated/server";
import { v } from "convex/values";
import { z } from "zod/v3";
import { weatherAgent } from "../agents/weather";
import { fashionAgent } from "../agents/fashion";
import { getAuthUserId } from "../utils";

/**
 * OPTION 1: Chain agent calls in a single action.
 *
 * This will do two steps in sequence with different agents:
 *
 * 1. Get the weather forecast
 * 2. Get fashion advice based on the weather
 */

export const getAdvice = action({
  args: { location: v.string(), threadId: v.string() },
  handler: async (ctx, { location, threadId }) => {
    const userId = await getAuthUserId(ctx);

    // Note: the message is saved automatically, and clients will get the
    // response via subscriptions automatically.
    await weatherAgent.generateText(
      ctx,
      { threadId, userId },
      { prompt: `What is the weather in ${location}?` },
    );

    // This includes previous message history from the thread automatically.
    await fashionAgent.generateText(
      ctx,
      { threadId, userId },
      { prompt: `What should I wear based on the weather?` },
    );
  },
});

/**
 * OPTION 2: Use agent actions in a workflow
 *
 * Workfows are durable functions that can survive server failures and retry
 * each step, calling queries, mutations, or actions.

 * They have higher guarantees around running to completion than normal
 * serverless functions. Each time a step finishes, the workflow re-executes,
 * fast-forwarding past steps it's already completed.
 */

const workflow = new WorkflowManager(components.workflow);

export const weatherAgentWorkflow = workflow.define({
  args: { location: v.string(), threadId: v.string() },
  handler: async (ctx, { location, threadId }): Promise<void> => {
    const weatherQ = await saveMessage(ctx, components.agent, {
      threadId,
      prompt: `What is the weather in ${location}?`,
    });
    const forecast = await ctx.runAction(
      internal.workflows.chaining.getForecast,
      { promptMessageId: weatherQ.messageId, threadId },
      { retry: true },
    );
    const fashionQ = await saveMessage(ctx, components.agent, {
      threadId,
      prompt: `What should I wear based on the weather?`,
    });
    const fashion = await ctx.runAction(
      internal.workflows.chaining.getFashionAdvice,
      { promptMessageId: fashionQ.messageId, threadId },
      {
        retry: { maxAttempts: 5, initialBackoffMs: 1000, base: 2 },
        // runAfter: 2 * 1000, // To add artificial delay
      },
    );
    console.log("Weather forecast:", forecast);
    console.log("Fashion advice:", fashion.object);
  },
});

export const startWorkflow = mutation({
  args: { location: v.string() },
  handler: async (
    ctx,
    { location },
    // It's best practice to annotate return types on all functions involved
    // in workflows, as circular types are common.
  ): Promise<{ threadId: string; workflowId: WorkflowId }> => {
    const userId = await getAuthUserId(ctx);
    const threadId = await createThread(ctx, components.agent, {
      userId,
      title: `Weather in ${location}`,
    });
    const workflowId = await workflow.start(
      ctx,
      internal.workflows.chaining.weatherAgentWorkflow,
      { location, threadId },
    );
    return { threadId, workflowId };
  },
});

/**
 * Expose the agents as actions
 *
 * Note: you could alternatively create your own actions that call the agent
 * internally.
 * This is a convenient shorthand.
 */
export const getForecast = weatherAgent.asTextAction({
  stopWhen: stepCountIs(3),
});
export const getFashionAdvice = fashionAgent.asObjectAction({
  schema: z.object({
    hat: z.string(),
    tops: z.string(),
    bottoms: z.string(),
    shoes: z.string(),
  }),
});
