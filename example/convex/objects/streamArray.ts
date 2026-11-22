import { action, query } from "../_generated/server.js";
import { vStreamArgs } from "@convex-dev/agent";
import { components } from "../_generated/api.js";
import { defaultConfig } from "../agents/config.js";
import z from "zod/v4";
import { v } from "convex/values";
import { syncStreams, DeltaStreamer } from "@convex-dev/agent";
import { Output, streamText } from "ai";
import { authorizeThreadAccess } from "../threads.js";
import { getAuthUserId } from "../utils.js";

export const streamArray = action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const response = streamText({
      model: defaultConfig.languageModel,
      prompt: "Make a list of items needed to host a birthday party",
      output: Output.array({
        element: z.object({
          name: z.string().describe("The name of the item"),
          quantity: z.number().describe("How many to bring"),
        }),
      }),
    });
    const streamer = new DeltaStreamer(
      components.agent,
      ctx,
      {
        throttleMs: 100,
        onAsyncAbort: async () => console.error("Aborted asynchronously"),
        compress: null,
        abortSignal: undefined,
      },
      {
        threadId,
        format: undefined,
        order: 0, // we are only sending one message in this thread.
        stepOrder: 0, // we are only sending one message in this thread.
        userId: await getAuthUserId(ctx),
      },
    );
    await streamer.consumeStream(response.elementStream);
    return {
      streamId: await streamer.getStreamId(),
      object: await response.output,
    };
  },
});

export const listDeltas = query({
  args: {
    threadId: v.string(),
    streamArgs: vStreamArgs,
  },
  handler: async (ctx, args) => {
    await authorizeThreadAccess(ctx, args.threadId);
    const streams = await syncStreams(ctx, components.agent, {
      ...args,
      includeStatuses: ["streaming", "aborted", "finished"],
    });
    return { streams };
  },
});
