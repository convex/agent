import { expect, test } from "vitest";
import { defineTestApp } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import componentTest from "../../test.js";
import { Agent, vOnSaveMessagesArgs } from "../index.js";
import { mockModel } from "./mockModel.js";

// https://github.com/convex/agent/issues/147
const app = defineTestApp({
  schema: defineSchema({
    events: defineTable({ messageId: v.string(), status: v.string() }),
  }),
  components: { agent: componentTest },
});
const component = app.components.agent;

const record = app.internalMutation({
  args: vOnSaveMessagesArgs,
  handler: async (ctx, { messages }) => {
    for (const m of messages) {
      await ctx.db.insert("events", { messageId: m._id, status: m.status });
    }
    return null;
  },
});

const recordThenThrow = app.internalMutation({
  args: vOnSaveMessagesArgs,
  handler: async (ctx, { messages }) => {
    await ctx.db.insert("events", { messageId: messages[0]._id, status: "x" });
    throw new Error("callback failed");
  },
});

const agentWith = ({ throws = false, providerFails = false } = {}) =>
  new Agent(component, {
    name: "hooked",
    languageModel: mockModel(
      providerFails
        ? { fail: { error: "provider down" } }
        : { content: [{ type: "text", text: "reply" }] },
    ),
    onSaveMessages: throws
      ? internal.onSave.recordThenThrow
      : internal.onSave.record,
  });

const generate = app.action({
  args: { threadId: v.string(), providerFails: v.boolean() },
  handler: async (ctx, { threadId, providerFails }) => {
    await agentWith({ providerFails })
      .generateText(ctx, { threadId }, { prompt: "hello" })
      .catch(() => {});
    return null;
  },
});

// From an action, so the save is its own transaction like a generation step.
const saveWithThrowingCallback = app.action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    await agentWith({ throws: true }).saveMessage(ctx, {
      threadId,
      prompt: "hi",
      skipEmbeddings: true,
    });
    return null;
  },
});

const savePending = app.mutation({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }): Promise<string> =>
    (
      await agentWith().saveMessage(ctx, {
        threadId,
        message: { role: "assistant", content: [] },
        metadata: { status: "pending" },
        skipEmbeddings: true,
      })
    ).messageId,
});

const finalizeFailed = app.mutation({
  args: { messageId: v.string() },
  handler: async (ctx, { messageId }) => {
    await agentWith().finalizeMessage(ctx, {
      messageId,
      result: { status: "failed", error: "stopped" },
    });
    return null;
  },
});

const restart = app.mutation({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }): Promise<string> =>
    (
      await agentWith().saveMessages(ctx, {
        threadId,
        messages: [{ role: "user", content: "again" }],
        failPendingSteps: true,
        skipEmbeddings: true,
      })
    ).messages[0]._id,
});

const requestAndApprove = app.mutation({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }): Promise<string[]> => {
    const agent = agentWith();
    const { messageId: request } = await agent.saveMessage(ctx, {
      threadId,
      skipEmbeddings: true,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-a",
            toolName: "deleteFile",
            input: {},
          },
          {
            type: "tool-approval-request",
            toolCallId: "call-a",
            approvalId: "a",
          },
        ],
      },
    });
    const { messageId: response } = await agent.approveToolCall(ctx, {
      threadId,
      approvalId: "a",
    });
    return [request, response];
  },
});

const createThread = app.mutation({
  args: {},
  handler: async (ctx): Promise<string> =>
    (await ctx.runMutation(component.threads.createThread, {}))._id,
});

const state = app.query({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    const { page } = await ctx.runQuery(
      component.messages.listMessagesByThreadId,
      {
        threadId,
        order: "asc",
        paginationOpts: { cursor: null, numItems: 50 },
      },
    );
    const events = await ctx.db.query("events").collect();
    return {
      messages: page.map((m) => ({ _id: m._id, status: m.status })),
      events: events.map(({ messageId, status }) => ({ messageId, status })),
    };
  },
});

const { api, internal, createTest } = app.defineModules({
  onSave: {
    record,
    recordThenThrow,
    generate,
    saveWithThrowingCallback,
    savePending,
    finalizeFailed,
    restart,
    requestAndApprove,
    createThread,
    state,
  },
});

async function setup() {
  const t = createTest();
  const threadId = await t.mutation(api.onSave.createThread, {});
  return { t, threadId, state: () => t.query(api.onSave.state, { threadId }) };
}

test.each([false, true])(
  "a generation reports the prompt, the pending step and its final status (provider fails: %s)",
  async (providerFails) => {
    const { t, threadId, state } = await setup();
    await t.action(api.onSave.generate, { threadId, providerFails });
    const { messages, events } = await state();
    const [prompt, reply] = messages;
    const final = providerFails ? "failed" : "success";
    expect(reply.status).toBe(final);
    expect(events).toEqual([
      { messageId: prompt._id, status: "success" },
      { messageId: reply._id, status: "pending" },
      { messageId: reply._id, status: final },
    ]);
  },
);

test("a throwing callback fails the save with it", async () => {
  const { t, threadId, state } = await setup();
  await expect(
    t.action(api.onSave.saveWithThrowingCallback, { threadId }),
  ).rejects.toThrow("callback failed");
  expect(await state()).toEqual({ messages: [], events: [] });
});

test("approval responses are reported", async () => {
  const { t, threadId, state } = await setup();
  const [request, response] = await t.mutation(api.onSave.requestAndApprove, {
    threadId,
  });
  expect((await state()).events).toEqual([
    { messageId: request, status: "success" },
    { messageId: response, status: "success" },
  ]);
});

test("a pending step failed by a restart is reported", async () => {
  const { t, threadId, state } = await setup();
  const pending = await t.mutation(api.onSave.savePending, { threadId });
  const next = await t.mutation(api.onSave.restart, { threadId });
  expect((await state()).events).toEqual([
    { messageId: pending, status: "pending" },
    { messageId: pending, status: "failed" },
    { messageId: next, status: "success" },
  ]);
});

test("finalizing reports every message recovered from the stream once", async () => {
  const { t, threadId, state } = await setup();
  const pending = await t.mutation(api.onSave.savePending, { threadId });
  const streamId = await t.mutation(component.streams.create, {
    threadId,
    order: 0,
    stepOrder: 0,
    format: "UIMessageChunk",
  });
  const parts = [
    { type: "start" },
    { type: "start-step" },
    {
      type: "tool-input-available",
      toolCallId: "call-1",
      toolName: "lookup",
      input: { q: "x" },
    },
    { type: "tool-output-available", toolCallId: "call-1", output: "found" },
    { type: "finish-step" },
    { type: "start-step" },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "partial" },
  ];
  await t.mutation(component.streams.addDelta, {
    streamId,
    start: 0,
    end: parts.length,
    parts,
  });
  await t.mutation(api.onSave.finalizeFailed, { messageId: pending });
  // Finalizing again is a no-op and reports nothing.
  await t.mutation(api.onSave.finalizeFailed, { messageId: pending });
  const { messages, events } = await state();
  expect(messages.length).toBeGreaterThan(1);
  expect(events).toEqual([
    { messageId: pending, status: "pending" },
    ...messages.map((m) => ({ messageId: m._id, status: m.status })),
  ]);
});
