import { v } from "convex/values";
import { mutation } from "./_generated/server.js";

// A durable tool's mutation: run once per tool call of the turn, and replayed
// from its record when a retry calls it again.
export const runToolMutation = mutation({
  args: {
    toolCallId: v.string(),
    handle: v.string(),
    args: v.any(),
  },
  returns: v.any(),
  handler: async () => {
    throw new Error("not implemented");
  },
});
