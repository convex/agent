import { describe, expect, test } from "vitest";
import { v } from "convex/values";
import { z } from "zod/v4";
import {
  Agent,
  createThread,
  listMessages,
  ModelCallRefusedError,
} from "../index.js";
import { app, components } from "./setup.test.js";
import { mockModel } from "./mockModel.js";

const throwingInstructions = new Agent(components.agent, {
  name: "setup-failure-instructions",
  languageModel: mockModel({ content: [{ type: "text", text: "ok" }] }),
  instructions: async () => {
    throw new Error("instructions failed");
  },
});

let middlewareError: Error = new Error("middleware failed");
const throwingMiddleware = new Agent(components.agent, {
  name: "setup-failure-middleware",
  languageModel: mockModel({ content: [{ type: "text", text: "{}" }] }),
  instructions: "test",
  languageModelMiddleware: async () => {
    throw middlewareError;
  },
});

const run = app.action({
  args: {
    threadId: v.string(),
    op: v.union(
      v.literal("generateText"),
      v.literal("streamText"),
      v.literal("generateObject"),
    ),
    agent: v.union(v.literal("instructions"), v.literal("middleware")),
    refuse: v.optional(v.boolean()),
  },
  handler: async (ctx, { threadId, op, agent: which, refuse }) => {
    const agent =
      which === "instructions" ? throwingInstructions : throwingMiddleware;
    middlewareError = refuse
      ? new ModelCallRefusedError("Over budget")
      : new Error("middleware failed");
    try {
      if (op === "generateText") {
        await agent.generateText(ctx, { threadId }, { prompt: "hi" });
      } else if (op === "streamText") {
        const result = await agent.streamText(
          ctx,
          { threadId },
          { prompt: "hi" },
          { saveStreamDeltas: true },
        );
        await result.consumeStream();
      } else {
        await agent.generateObject(
          ctx,
          { threadId },
          { prompt: "hi", schema: z.object({}) },
        );
      }
      return "no error";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  },
});

const { api, createTest } = app.defineModules({ setupFailure: { run } });

async function runAndList(args: {
  op: "generateText" | "streamText" | "generateObject";
  agent: "instructions" | "middleware";
  refuse?: boolean;
}) {
  const t = createTest();
  const threadId = await t.run((ctx) =>
    createThread(ctx, components.agent, { userId: "u" }),
  );
  const error = await t.action(api.setupFailure.run, {
    threadId,
    ...args,
  });
  const { page } = await t.run((ctx) =>
    listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 20 },
      statuses: ["pending", "failed", "success"],
    }),
  );
  return {
    error,
    messages: page.reverse().map((m) => [m.message?.role, m.status]),
  };
}

describe("setup that throws after the pending message is saved", () => {
  for (const op of ["generateText", "streamText", "generateObject"] as const) {
    test(`a throwing instructions function fails the reply (${op})`, async () => {
      const { error, messages } = await runAndList({
        op,
        agent: "instructions",
      });
      expect(error).toBe("instructions failed");
      expect(messages).toEqual([
        ["user", "success"],
        ["assistant", "failed"],
      ]);
    });
  }

  test("throwing middleware fails the reply (generateObject)", async () => {
    const { error, messages } = await runAndList({
      op: "generateObject",
      agent: "middleware",
    });
    expect(error).toBe("middleware failed");
    expect(messages).toEqual([
      ["user", "success"],
      ["assistant", "failed"],
    ]);
  });

  test("refusing middleware deletes the reply (generateObject)", async () => {
    const { error, messages } = await runAndList({
      op: "generateObject",
      agent: "middleware",
      refuse: true,
    });
    expect(error).toBe("Over budget");
    expect(messages).toEqual([["user", "success"]]);
  });
});
