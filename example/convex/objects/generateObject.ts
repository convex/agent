import { action } from "../_generated/server.js";
import { Agent, createThread } from "@convex-dev/agent";
import { components } from "../_generated/api.js";
import { defaultConfig } from "../agents/config.js";
import z from "zod/v4";
import { assert } from "convex-helpers";

export const createObject = action({
  args: {},
  handler: async (ctx) => {
    const agent = new Agent(components.agent, {
      ...defaultConfig,
      name: "object-agent",
    });
    const threadId = await createThread(ctx, components.agent);
    const { object } = await agent.generateObject(
      ctx,
      { threadId },
      {
        prompt: "Generate a plan to make a sandwich",
        schema: z.object({
          summary: z.string(),
          steps: z.array(z.string()),
        }),
      },
    );
    assert(typeof object.summary === "string");
    for (const step of object.steps) {
      assert(typeof step === "string");
    }
    return object;
  },
});

export const createEnum = action({
  args: {},
  handler: async (ctx) => {
    const agent = new Agent(components.agent, {
      ...defaultConfig,
      name: "object-agent",
    });
    const threadId = await createThread(ctx, components.agent);
    const { object } = await agent.generateObject(
      ctx,
      { threadId },
      {
        prompt: "Generate a plan to make a sandwich",
        output: "enum",
        enum: ["hello", "world"],
      },
    );
    assert(object === "hello" || object === "world");
    return object;
  },
});

export const createArray = action({
  args: {},
  handler: async (ctx) => {
    const agent = new Agent(components.agent, {
      ...defaultConfig,
      name: "object-agent",
    });
    const threadId = await createThread(ctx, components.agent);
    const { object } = await agent.generateObject(
      ctx,
      { threadId },
      {
        prompt: "Generate a plan to make a sandwich",
        output: "array",
        schema: z.string(),
      },
    );
    for (const step of object) {
      assert(typeof step === "string");
    }
    return object;
  },
});
