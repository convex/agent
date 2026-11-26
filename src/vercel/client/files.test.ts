/// <reference types="vite/client" />

import { describe, expect, test, vi } from "vitest";
import { storeFile } from "./files.js";
import { components, initConvexTest } from "./setup.test.js";

// sha256("hello") in hex and base64
const HELLO_SHA256 =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const HELLO_SHA256_BASE64 = "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=";

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
        getMetadata: async () => null,
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

  test.each([HELLO_SHA256, HELLO_SHA256.toUpperCase()])(
    "stores a blob under its sha256 %s and asks storage to verify it",
    async (sha256) => {
      const t = initConvexTest();
      // convex-test ignores the sha256 option for actions, so a mismatched
      // blob would store anyway; assert what reaches storage instead.
      const { text, storeOptions } = await t.action(async (ctx) => {
        const store = vi.spyOn(ctx.storage, "store");
        const { file } = await storeFile(
          ctx,
          components.agent,
          new Blob(["hello"]),
          { sha256 },
        );
        return {
          text: await (await ctx.storage.get(file.storageId))?.text(),
          storeOptions: store.mock.calls[0][1],
        };
      });
      expect(text).toBe("hello");
      expect(storeOptions).toEqual({ sha256: HELLO_SHA256_BASE64 });
    },
  );

  test("rejects an empty sha256 instead of storing unverified", async () => {
    const t = initConvexTest();
    await expect(
      t.action(async (ctx) => {
        await storeFile(ctx, components.agent, new Blob(["hello"]), {
          sha256: "",
        });
      }),
    ).rejects.toThrow("sha256 must be 64 hex characters");
  });
});
