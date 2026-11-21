import { makeFunctionReference, type FunctionHandle } from "convex/server";
import { vOnSaveMessagesArgs } from "../onSaveMessagesArgs.js";
import type { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import { v } from "./schema.js";

// Named rather than imported from `internal`, which would split
// _generated/api.js into a chunk every component call then loads.
const self = makeFunctionReference(
  "onSaveMessages:dispatch",
) as unknown as typeof internal.onSaveMessages.dispatch;

// Each dispatcher schedules at most this many, under Convex's 1,000 per
// transaction, and each thread's hook runs alone in its own transaction, so a
// hook that fails, even past a transaction limit, can't drop another thread's
// report.
const FAN_OUT = 100;

export const dispatch = internalMutation({
  args: { handle: v.string(), reports: v.array(vOnSaveMessagesArgs) },
  returns: v.null(),
  handler: async (ctx, { handle, reports }) => {
    if (reports.length === 1) {
      const [report] = reports;
      try {
        await ctx.runMutation(handle as FunctionHandle<"mutation">, report);
      } catch (error) {
        console.error(
          `onSaveMessages failed for thread ${report.threadId}, dropping its report of ${report.messages.length} message(s):`,
          error,
        );
      }
      return null;
    }
    const size = Math.ceil(reports.length / FAN_OUT);
    for (let i = 0; i < reports.length; i += size) {
      await ctx.scheduler.runAfter(0, self, {
        handle,
        reports: reports.slice(i, i + size),
      });
    }
    return null;
  },
});
