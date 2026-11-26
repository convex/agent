/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { storeFile } from "./files.js";

describe("storeFile", () => {
  test("throws a clear error when a reused file is missing from storage", async () => {
    const ctx = {
      runAction: async () => null,
      runMutation: async () => ({
        fileId: "existing-file",
        storageId: "existing-storage",
      }),
      storage: {
        getUrl: async () => null,
      },
    } as unknown as Parameters<typeof storeFile>[0];
    const component = {
      files: { useExistingFile: {}, addFile: {} },
    } as unknown as Parameters<typeof storeFile>[1];

    await expect(storeFile(ctx, component, new Blob(["x"]))).rejects.toThrow(
      "File not found in storage: existing-storage",
    );
  });

  test("cleans its losing blob before an existing URL read fails", async () => {
    const deleted: string[] = [];
    let mutationCount = 0;
    const ctx = {
      runAction: async () => null,
      runMutation: async () => {
        mutationCount++;
        return mutationCount === 1
          ? null
          : { fileId: "existing-file", storageId: "existing-storage" };
      },
      storage: {
        store: async () => "new-storage",
        getUrl: async () => null,
        delete: async (storageId: string) => {
          deleted.push(storageId);
        },
      },
    } as unknown as Parameters<typeof storeFile>[0];
    const component = {
      files: { useExistingFile: {}, addFile: {} },
    } as unknown as Parameters<typeof storeFile>[1];

    await expect(storeFile(ctx, component, new Blob(["x"]))).rejects.toThrow(
      "File not found in storage: existing-storage",
    );
    expect(deleted).toEqual(["new-storage"]);
  });

  test("has storage verify the caller's sha256 as it writes", async () => {
    const storeOptions: unknown[] = [];
    const component = {
      files: { useExistingFile: {}, addFile: {} },
    } as unknown as Parameters<typeof storeFile>[1];
    const ctx = {
      runAction: async () => null,
      runMutation: async (ref: unknown) =>
        ref === component.files.useExistingFile
          ? null
          : { fileId: "new-file", storageId: "new-storage" },
      storage: {
        store: async (_blob: Blob, options?: unknown) => {
          storeOptions.push(options);
          return "new-storage";
        },
        getUrl: async () => "https://example.com/new-storage",
      },
    } as unknown as Parameters<typeof storeFile>[0];
    // sha256("hello")
    const sha256 =
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    await storeFile(ctx, component, new Blob(["hello"]), { sha256 });
    await storeFile(ctx, component, new Blob(["hello"]), {
      sha256: sha256.toUpperCase(),
    });
    await expect(
      storeFile(ctx, component, new Blob(["hello"]), {
        sha256: sha256.slice(1),
      }),
    ).rejects.toThrow("sha256 must be 64 hex characters");
    await expect(
      storeFile(ctx, component, new Blob(["hello"]), { sha256: "" }),
    ).rejects.toThrow("sha256 must be 64 hex characters");
    expect(storeOptions).toEqual([
      { sha256: "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=" },
      { sha256: "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=" },
    ]);
  });
});
