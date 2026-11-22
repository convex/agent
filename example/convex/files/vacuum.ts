// See the docs at https://docs.convex.dev/agents/files
import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { components, internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";

const THRESHOLD_MS = 1000 * 60 * 60 * 24; // 24 hours

// Registered in convex/crons.ts
export const deleteUnusedFiles = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const files = await ctx.runQuery(components.agent.files.getFilesToDelete, {
      paginationOpts: {
        cursor: args.cursor ?? null,
        numItems: 100,
      },
    });
    // Only delete files that haven't been touched in the last 24 hours
    const toDelete = files.page.filter(
      (f) => f.lastTouchedAt < Date.now() - THRESHOLD_MS,
    );
    if (toDelete.length > 0) {
      console.debug(`Deleting ${toDelete.length} files...`);
    }
    // This is in a transaction (mutation), so there's no races.
    const deletedIds = await ctx.runMutation(
      components.agent.files.deleteFiles,
      { fileIds: toDelete.map((f) => f._id) },
    );
    await Promise.all(
      toDelete
        .filter((f) => deletedIds.includes(f._id))
        .map(async (f) => {
          const storageId = f.storageId as Id<"_storage">;
          // A blob that's already gone would otherwise roll back the batch.
          if (await ctx.db.system.get("_storage", storageId)) {
            await ctx.storage.delete(storageId);
          }
        }),
    );
    if (!files.isDone) {
      console.debug(
        `Deleted ${toDelete.length} files but not done yet, continuing...`,
      );
      await ctx.scheduler.runAfter(0, internal.files.vacuum.deleteUnusedFiles, {
        cursor: files.continueCursor,
      });
    }
  },
});
