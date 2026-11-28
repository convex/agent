import type { FunctionReference } from "convex/server";
import { expectTypeOf, test } from "vitest";
import { z } from "zod/v4";
import { createTool } from "./createTool.js";

declare const place: FunctionReference<
  "mutation",
  "internal",
  { userId: string; item: string },
  { orderId: string }
>;
declare const listForUser: FunctionReference<
  "query",
  "internal",
  { userId: string },
  string[]
>;
declare const publicPlace: FunctionReference<
  "mutation",
  "public",
  { userId: string; item: string },
  { orderId: string }
>;
const item = z.object({ item: z.string() });

test("a mutation tool runs internal mutations, and a query tool can't write", () => {
  expectTypeOf(() => {
    createTool({
      inputSchema: item,
      mutation: (ctx, input): Promise<{ orderId: string }> =>
        // @ts-expect-error a public mutation
        ctx.runMutation(publicPlace, { ...input, userId: "u" }),
    });
    createTool({
      inputSchema: item,
      query: (ctx, input): Promise<{ orderId: string }> =>
        // @ts-expect-error a query tool has no runMutation
        ctx.runMutation(place, { ...input, userId: "u" }),
    });
  }).toBeFunction();
});

test("a tool runs one of execute, mutation or query", () => {
  expectTypeOf(() => {
    // @ts-expect-error a mutation tool has no execute
    createTool({
      inputSchema: item,
      mutation: (ctx, input): Promise<{ orderId: string }> =>
        ctx.runMutation(place, { ...input, userId: "u" }),
      execute: async () => ({ orderId: "o" }),
    });
    createTool({
      inputSchema: item,
      // @ts-expect-error a query tool has no resume
      query: (ctx): Promise<string[]> =>
        ctx.runQuery(listForUser, { userId: "u" }),
      resume: async () => [],
    });
    createTool({
      inputSchema: item,
      execute: async (_ctx, { item }) => item,
      resume: async (_ctx, { item }) => item,
    });
    // @ts-expect-error resume reruns an execute tool's call, so it needs execute
    createTool({
      inputSchema: item,
      resume: async () => "again",
    });
  }).toBeFunction();
});
