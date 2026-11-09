import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, type MutationCtx, query } from "./_generated/server.js";
import { v } from "./schema.js";
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import type { Infer } from "convex/values";

const FILE_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1000;

// Files touched at the cutoff are kept, so one reused in the same millisecond
// the caller took its cutoff survives.
function cleanupCutoff(lastTouchedBefore: number | undefined) {
  if (lastTouchedBefore === undefined) {
    return Date.now() - FILE_CLEANUP_GRACE_MS;
  }
  // A future cutoff would let deleteFiles delete a file reused after listing.
  if (!(lastTouchedBefore <= Date.now())) {
    throw new Error(
      `lastTouchedBefore must be a timestamp no later than now, got ${lastTouchedBefore}`,
    );
  }
  return lastTouchedBefore;
}

const addFileArgs = v.object({
  storageId: v.string(),
  hash: v.string(),
  filename: v.optional(v.string()),
  mediaType: v.optional(v.string()),
  /** @deprecated Use `mediaType` instead. */
  mimeType: v.optional(v.string()),
});

export const addFile = mutation({
  args: addFileArgs,
  handler: addFileHandler,
  returns: {
    fileId: v.id("files"),
    storageId: v.string(),
  },
});

export async function addFileHandler(
  ctx: MutationCtx,
  args: Infer<typeof addFileArgs>,
) {
  // Support both mediaType (preferred) and mimeType (deprecated)
  const mediaType = normalizeMediaType(args.mediaType ?? args.mimeType);

  const existingFiles = await ctx.db
    .query("files")
    .withIndex("hash", (q) => q.eq("hash", args.hash))
    // eslint-disable-next-line @convex-dev/no-filter-in-query -- We do not expect many files with the same hash and different filenames
    .filter((q) => q.eq(q.field("filename"), args.filename))
    .collect();
  const existingFile = existingFiles.find((file) =>
    sameMediaType(file, mediaType),
  );
  if (existingFile) {
    // Registration is not ownership. Persisted messages and in-flight streams
    // acquire ownership explicitly.
    await ctx.db.patch("files", existingFile._id, {
      lastTouchedAt: Date.now(),
    });
    return {
      fileId: existingFile._id,
      storageId: existingFile.storageId,
    };
  }
  const fileId = await ctx.db.insert("files", {
    storageId: args.storageId,
    hash: args.hash,
    filename: args.filename,
    mediaType,
    mimeType: args.mimeType, // Keep for backwards compatibility
    // We start out with it unused - when it's saved in a message we increment.
    refcount: 0,
    lastTouchedAt: Date.now(),
  });
  return {
    fileId,
    storageId: args.storageId,
  };
}

export const get = query({
  args: {
    fileId: v.id("files"),
  },
  returns: v.union(v.null(), v.doc("files")),
  handler: async (ctx, args) => {
    return ctx.db.get("files", args.fileId);
  },
});

/**
 * If you plan to have the same file added over and over without a reference to
 * the fileId, you can use this query to get the fileId of the existing file.
 * Note: this will not increment the refcount. only saving messages does that.
 * It will only match if the filename is the same (or both are undefined).
 */
export const useExistingFile = mutation({
  args: {
    hash: v.string(),
    filename: v.optional(v.string()),
    mediaType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("files")
      .withIndex("hash", (q) => q.eq("hash", args.hash))
      // eslint-disable-next-line @convex-dev/no-filter-in-query -- We do not expect many files with the same hash and different filenames
      .filter((q) => q.eq(q.field("filename"), args.filename))
      .collect();
    const file = files.find((candidate) =>
      sameMediaType(candidate, normalizeMediaType(args.mediaType)),
    );
    if (!file) {
      return null;
    }
    await ctx.db.patch("files", file._id, {
      lastTouchedAt: Date.now(),
    });
    return { fileId: file._id, storageId: file.storageId };
  },
  returns: v.union(
    v.null(),
    v.object({
      fileId: v.id("files"),
      storageId: v.string(),
    }),
  ),
});

function normalizeMediaType(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function sameMediaType(
  file: Pick<Doc<"files">, "mediaType" | "mimeType">,
  expected: string | undefined,
) {
  const actual = normalizeMediaType(file.mediaType ?? file.mimeType);
  // File rows from before media-type tracking have no value to distinguish.
  // Preserve the prior hash-and-filename reuse behavior for those rows.
  return expected === undefined || actual === undefined || actual === expected;
}

/** Transfer ownership between two durable records. */
export async function changeRefcount(
  ctx: MutationCtx,
  previous: Id<"files">[],
  next: Id<"files">[],
) {
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  for (const fileId of new Set([...previousSet, ...nextSet])) {
    const increment = Number(!previousSet.has(fileId) && nextSet.has(fileId));
    const decrement = Number(previousSet.has(fileId) && !nextSet.has(fileId));
    if (increment === 0 && decrement === 0) continue;
    const file = await ctx.db.get("files", fileId);
    if (!file) {
      if (increment === 0) {
        console.error(`File ${fileId} not found when decrementing refcount`);
        continue;
      }
      throw new Error(`File ${fileId} not found when incrementing refcount`);
    }
    if (file.refcount < decrement) {
      throw new Error(
        `File ${fileId} refcount underflow: ${file.refcount} - ${decrement}`,
      );
    }
    const delta = increment - decrement;
    await ctx.db.patch("files", fileId, {
      refcount: file.refcount + delta,
      lastTouchedAt: Date.now(),
    });
  }
}

export const copyFile = mutation({
  args: {
    fileId: v.id("files"),
  },
  handler: copyFileHandler,
  returns: v.null(),
});

export async function copyFileHandler(
  ctx: MutationCtx,
  args: { fileId: Id<"files"> },
) {
  await changeRefcount(ctx, [], [args.fileId]);
}

/**
 * Get files that are unused and can be deleted.
 * This is useful for cleaning up files that are no longer needed.
 * Files remain protected for 24 hours after registration or their last
 * ownership change, so a file cannot be removed between registration and the
 * transaction that saves its message or stream reference.
 * `lastTouchedBefore` (ms since epoch, not in the future) moves that cutoff. A later one also
 * lists uploads and generated files not yet in a saved message, so stop those
 * first, e.g. in a dev reset.
 */
export const getFilesToDelete = query({
  args: {
    paginationOpts: paginationOptsValidator,
    lastTouchedBefore: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query("files")
      .withIndex("refcount_lastTouchedAt", (q) =>
        q
          .eq("refcount", 0)
          .lt("lastTouchedAt", cleanupCutoff(args.lastTouchedBefore)),
      )
      .paginate(args.paginationOpts);
    return files;
  },
  returns: paginationResultValidator(v.doc("files")),
});

export const deleteFiles = mutation({
  args: {
    fileIds: v.array(v.id("files")),
    force: v.optional(v.boolean()),
    /** Pass the same cutoff as `getFilesToDelete` to keep files used since. */
    lastTouchedBefore: v.optional(v.number()),
  },
  returns: v.array(v.id("files")),
  handler: async (ctx, args) => {
    const cutoff = cleanupCutoff(args.lastTouchedBefore);
    const deletedFileIds = await Promise.all(
      args.fileIds.map(async (fileId) => {
        const file = await ctx.db.get("files", fileId);
        if (!file) {
          console.error(`File ${fileId} not found when deleting, skipping...`);
          return null;
        }
        if (file.refcount && file.refcount > 0) {
          if (!args.force) {
            console.error(
              `File ${fileId} has refcount ${file.refcount} > 0, skipping...`,
            );
            return null;
          }
        }
        if (!args.force && file.lastTouchedAt >= cutoff) {
          console.error(
            `File ${fileId} was touched after the cleanup cutoff, skipping...`,
          );
          return null;
        }
        await ctx.db.delete("files", fileId);
        return fileId;
      }),
    );
    return deletedFileIds.filter((fileId) => fileId !== null);
  },
});
