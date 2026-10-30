/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./setup.test.js";
import type { Doc } from "./_generated/dataModel.js";
import type { PaginationResult } from "convex/server";

describe("files", () => {
  afterEach(() => vi.useRealTimers());
  test("addFile registers and reuses a file without acquiring ownership", async () => {
    const t = convexTest(schema, modules);
    const storageId = "storage-1";
    const hash = "hash-1";
    const filename = "file.txt";
    // Add the file for the first time
    const { fileId, storageId: returnedStorageId } = await t.mutation(
      api.files.addFile,
      {
        storageId,
        hash,
        filename,
        mimeType: "text/plain",
      },
    );
    expect(fileId).toBeTruthy();
    expect(returnedStorageId).toBe(storageId);
    // Add the same file again
    const { fileId: fileId2 } = await t.mutation(api.files.addFile, {
      storageId,
      hash,
      filename,
      mimeType: "text/plain",
    });
    expect(fileId2).toBe(fileId);
    await expect(t.query(api.files.get, { fileId })).resolves.toMatchObject({
      refcount: 0,
    });
    // Add the same file with a different filename (should create a new entry)
    const { fileId: fileId3 } = await t.mutation(api.files.addFile, {
      storageId,
      hash,
      filename: "other.txt",
      mimeType: "text/plain",
    });
    expect(fileId3).not.toBe(fileId);
    // Add the same file with undefined filename (should create a new entry)
    const { fileId: fileId4 } = await t.mutation(api.files.addFile, {
      storageId,
      hash,
      filename: undefined,
      mimeType: "text/plain",
    });
    expect(fileId4).not.toBe(fileId);
  });

  test("useExistingFile only matches files with the same hash and filename", async () => {
    const t = convexTest(schema, modules);
    const storageId = "storage-2";
    const hash = "hash-2";
    const filename = "file2.txt";
    // Add a file
    const { fileId } = await t.mutation(api.files.addFile, {
      storageId,
      hash,
      filename,
      mimeType: "text/plain",
    });
    // Should match
    const fileId2 = await t.mutation(api.files.useExistingFile, {
      hash,
      filename,
    });
    expect(fileId2?.fileId).toBe(fileId);
    // Should not match with different filename
    const fileId3 = await t.mutation(api.files.useExistingFile, {
      hash,
      filename: "other2.txt",
    });
    expect(fileId3).toBeNull();
    // Should not match with undefined filename
    const fileId4 = await t.mutation(api.files.useExistingFile, {
      hash,
    });
    expect(fileId4).toBeNull();
  });

  test("reuses a legacy file row with no media type", async () => {
    const t = convexTest(schema, modules);
    const fileId = await t.run((ctx) =>
      ctx.db.insert("files", {
        storageId: "legacy-storage",
        hash: "legacy-hash",
        filename: "legacy.txt",
        refcount: 0,
        lastTouchedAt: Date.now(),
      }),
    );

    await expect(
      t.mutation(api.files.addFile, {
        storageId: "new-storage",
        hash: "legacy-hash",
        filename: "legacy.txt",
        mediaType: "text/plain",
      }),
    ).resolves.toEqual({ fileId, storageId: "legacy-storage" });
  });

  test("getFilesToDelete paginates through files with refcount 0 one at a time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const t = convexTest(schema, modules);
    // Add 3 files with refcount 0
    const files = [];
    for (let i = 0; i < 3; i++) {
      const { fileId } = await t.mutation(api.files.addFile, {
        storageId: `storage-del-${i}`,
        hash: `hash-del-${i}`,
        filename: `file-del-${i}.txt`,
        mimeType: "text/plain",
      });
      files.push(fileId);
    }
    // Past the grace period for every file: Date.now() is pinned per
    // mutation, so later inserts can be a few ms ahead of the fake clock.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1000);
    // Paginate through files to delete one at a time
    let cursor: string | null = null;
    const seen: string[] = [];
    let isDone = false;
    for (let i = 0; i < 3; i++) {
      expect(isDone).toBe(false);
      const result: PaginationResult<Doc<"files">> = await t.query(
        api.files.getFilesToDelete,
        { paginationOpts: { numItems: 1, cursor } },
      );
      expect(result.page.length).toBe(1);
      seen.push(result.page[0]._id);
      cursor = result.continueCursor;
      isDone = result.isDone;
    }
    // Built-in pagination may report isDone on the last full page; otherwise
    // the next page is empty and done.
    if (!isDone) {
      const { page, isDone } = await t.query(api.files.getFilesToDelete, {
        paginationOpts: { numItems: 1, cursor },
      });
      expect(page.length).toBe(0);
      expect(isDone).toBe(true);
    }
    // All fileIds should be seen
    expect(seen.sort()).toEqual(files.sort());
  });

  test("does not expose or delete freshly registered files", async () => {
    const t = convexTest(schema, modules);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fileId } = await t.mutation(api.files.addFile, {
      storageId: "storage-fresh",
      hash: "hash-fresh",
      filename: "fresh.txt",
      mimeType: "text/plain",
    });

    await expect(
      t.query(api.files.getFilesToDelete, {
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).resolves.toMatchObject({ page: [] });
    await expect(
      t.mutation(api.files.deleteFiles, { fileIds: [fileId] }),
    ).resolves.toEqual([]);
    await expect(t.query(api.files.get, { fileId })).resolves.not.toBeNull();
    error.mockRestore();
  });

  test("refreshes a cache hit before the cleanup grace period expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const t = convexTest(schema, modules);
    const { fileId } = await t.mutation(api.files.addFile, {
      storageId: "storage-cache-hit",
      hash: "cache-hit-hash",
      filename: "cache-hit.txt",
      mediaType: "text/plain",
    });

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 60 * 1000);
    await expect(
      t.mutation(api.files.useExistingFile, {
        hash: "cache-hit-hash",
        filename: "cache-hit.txt",
        mediaType: "text/plain",
      }),
    ).resolves.toMatchObject({ fileId });

    vi.advanceTimersByTime(60 * 1000);
    await expect(
      t.query(api.files.getFilesToDelete, {
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).resolves.toMatchObject({ page: [] });
  });

  test("a cutoff lists recent files, and keeps those used at or after it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const t = convexTest(schema, modules);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const add = (name: string) =>
      t.mutation(api.files.addFile, {
        storageId: `storage-${name}`,
        hash: `hash-${name}`,
        filename: `${name}.txt`,
        mediaType: "text/plain",
      });
    const { fileId: orphan } = await add("orphan");
    const { fileId: referenced } = await add("referenced");
    const { fileId: reused } = await add("reused");

    vi.advanceTimersByTime(1000);
    const lastTouchedBefore = Date.now();
    const { page } = await t.query(api.files.getFilesToDelete, {
      paginationOpts: { numItems: 10, cursor: null },
      lastTouchedBefore,
    });
    expect(page.map((f) => f._id).sort()).toEqual(
      [orphan, referenced, reused].sort(),
    );

    await t.mutation(api.files.copyFile, { fileId: referenced });
    // Reuse doesn't add a reference: the message saving it does, later.
    await t.mutation(api.files.useExistingFile, {
      hash: "hash-reused",
      filename: "reused.txt",
      mediaType: "text/plain",
    });
    await expect(
      t.mutation(api.files.deleteFiles, {
        fileIds: page.map((f) => f._id),
        lastTouchedBefore,
      }),
    ).resolves.toEqual([orphan]);
    await expect(
      t.query(api.files.get, { fileId: reused }),
    ).resolves.not.toBeNull();
    await expect(
      t.query(api.files.get, { fileId: referenced }),
    ).resolves.toMatchObject({ refcount: 1 });
    error.mockRestore();
  });

  test.each([NaN, Date.now() + 60_000])(
    "rejects a %s cutoff without deleting",
    async (lastTouchedBefore) => {
      const t = convexTest(schema, modules);
      const { fileId } = await t.mutation(api.files.addFile, {
        storageId: "storage-bad-cutoff",
        hash: "hash-bad-cutoff",
        filename: "bad.txt",
        mediaType: "text/plain",
      });
      await expect(
        t.query(api.files.getFilesToDelete, {
          paginationOpts: { numItems: 10, cursor: null },
          lastTouchedBefore,
        }),
      ).rejects.toThrow("lastTouchedBefore");
      await expect(
        t.mutation(api.files.deleteFiles, {
          fileIds: [fileId],
          lastTouchedBefore,
        }),
      ).rejects.toThrow("lastTouchedBefore");
      await expect(t.query(api.files.get, { fileId })).resolves.not.toBeNull();
    },
  );
});
