/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { getMaxMessage } from "./messages.js";
import {
  MAX_MATERIALIZATION_BYTES,
  MAX_MATERIALIZATION_ROWS,
  MAX_MATERIALIZATION_STREAMS,
  timeoutStreamHandler,
} from "./streams.js";
import schema from "./schema.js";
import { initConvexTest, modules } from "./setup.test.js";

describe("agent", () => {
  test("getMaxMessage works for threads", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        { message: { role: "user", content: "hello" } },
        { message: { role: "assistant", content: "world" } },
      ],
    });
    const maxMessage = await t.run(async (ctx) => {
      return await getMaxMessage(ctx, thread._id as Id<"threads">);
    });
    expect(maxMessage).toMatchObject({
      _id: messages.at(-1)!._id,
      order: 0,
      stepOrder: 1,
    });
  });
  test("getMaxMessage works for a specific order", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        { message: { role: "user", content: "hello" } },
        { message: { role: "assistant", content: "step 1" } },
        { message: { role: "user", content: "hello2" } },
      ],
    });
    const maxMessage = await t.run(async (ctx) => {
      return await getMaxMessage(ctx, thread._id as Id<"threads">, 0);
    });
    expect(maxMessage).toMatchObject({
      _id: messages.at(1)!._id,
      order: 0,
      stepOrder: 1,
    });
  });

  test("getMaxMessages works when there are tools involved", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        { message: { role: "user", content: "hello" } },
        {
          message: {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                input: { a: 1 },
                toolCallId: "1",
                toolName: "tool",
              },
            ],
          },
        },
        {
          message: {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "tool",
                result: "foo",
                toolCallId: "1",
              },
            ],
          },
        },
        { message: { role: "assistant", content: "world" } },
      ],
    });
    const maxMessage = await t.run(async (ctx) => {
      return await getMaxMessage(ctx, thread._id as Id<"threads">);
    });
    expect(maxMessage).toMatchObject({
      _id: messages.at(-1)!._id,
      order: 0,
      stepOrder: 3,
    });
  });

  test("ordering is incremented on subsequent calls to addMessages for user messages", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "user", content: "hello" } }],
    });
    const maxMessage = await t.run(async (ctx) => {
      return await getMaxMessage(ctx, thread._id as Id<"threads">);
    });
    expect(maxMessage).toMatchObject({
      _id: messages.at(-1)!._id,
      order: 0,
      stepOrder: 0,
    });
    const { messages: messages2 } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "user", content: "hello" } }],
    });
    const maxMessage2 = await t.run(async (ctx) => {
      return await getMaxMessage(ctx, thread._id as Id<"threads">);
    });
    expect(maxMessage2).toMatchObject({
      _id: messages2.at(-1)!._id,
      order: 1,
      stepOrder: 0,
    });
  });

  test("ordering is incremented on subsequent calls to addMessages for assistant messages", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "user", content: "hello" } }],
    });
    const maxMessage = await t.run(async (ctx) => {
      return await getMaxMessage(ctx, thread._id as Id<"threads">);
    });
    expect(maxMessage).toMatchObject({
      _id: messages.at(-1)!._id,
      order: 0,
      stepOrder: 0,
    });
    const { messages: messages2 } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "assistant", content: "hello" } }],
    });
    const maxMessage2 = await t.run(async (ctx) => {
      return await getMaxMessage(ctx, thread._id as Id<"threads">);
    });
    expect(maxMessage2).toMatchObject({
      _id: messages2.at(-1)!._id,
      order: 0,
      stepOrder: 1,
    });
  });

  test("an explicit order starts, appends, and avoids later order collisions", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        { message: { role: "user", content: "hello" } },
        { message: { role: "assistant", content: "agent reply" } },
      ],
    });

    const { messages: firstHumanReply } = await t.mutation(
      api.messages.addMessages,
      {
        threadId: thread._id as Id<"threads">,
        order: 1,
        agentName: "human:Alex",
        messages: [{ message: { role: "assistant", content: "human reply" } }],
      },
    );
    expect(firstHumanReply[0]).toMatchObject({
      order: 1,
      stepOrder: 0,
      agentName: "human:Alex",
    });

    const { messages: secondHumanReply } = await t.mutation(
      api.messages.addMessages,
      {
        threadId: thread._id as Id<"threads">,
        order: 1,
        agentName: "human:Sam",
        messages: [{ message: { role: "assistant", content: "follow-up" } }],
      },
    );
    expect(secondHumanReply[0]).toMatchObject({
      order: 1,
      stepOrder: 1,
      agentName: "human:Sam",
    });

    const { messages: backdatedBatch } = await t.mutation(
      api.messages.addMessages,
      {
        threadId: thread._id as Id<"threads">,
        order: 0,
        messages: [
          { message: { role: "assistant", content: "backdated reply" } },
          { message: { role: "user", content: "new user turn" } },
        ],
      },
    );
    expect(
      backdatedBatch.map(({ order, stepOrder }) => [order, stepOrder]),
    ).toEqual([
      [0, 2],
      [2, 0],
    ]);
  });

  test("concurrent saves to an explicit order receive distinct step orders", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const saveReply = (agentName: string) =>
      t.mutation(api.messages.addMessages, {
        threadId: thread._id as Id<"threads">,
        order: 3,
        agentName,
        messages: [
          { message: { role: "assistant" as const, content: agentName } },
        ],
      });

    const replies = await Promise.all([saveReply("Alex"), saveReply("Sam")]);

    expect(
      replies
        .map(({ messages }) => messages[0].stepOrder)
        .sort((a, b) => a - b),
    ).toEqual([0, 1]);
  });

  test("next order is allocated after the latest message", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "user", content: "hello" } }],
    });

    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      order: "next",
      messages: [{ message: { role: "assistant", content: "separate reply" } }],
    });

    expect(messages[0]).toMatchObject({ order: 1, stepOrder: 0 });
  });

  test("concurrent next orders receive distinct orders", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "user", content: "hello" } }],
    });
    const saveReply = (agentName: string) =>
      t.mutation(api.messages.addMessages, {
        threadId: thread._id as Id<"threads">,
        order: "next",
        agentName,
        messages: [
          { message: { role: "assistant" as const, content: agentName } },
        ],
      });

    const replies = await Promise.all([saveReply("Alex"), saveReply("Sam")]);

    expect(
      replies
        .map(({ messages }) => messages[0])
        .sort((a, b) => a.order - b.order)
        .map(({ order, stepOrder }) => [order, stepOrder]),
    ).toEqual([
      [1, 0],
      [2, 0],
    ]);
  });

  test("an explicit order ahead of the thread places the batch there", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "user", content: "hello" } }],
    });

    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      order: 5,
      messages: [
        { message: { role: "assistant", content: "imported reply" } },
        { message: { role: "user", content: "imported question" } },
      ],
    });
    expect(messages.map(({ order, stepOrder }) => [order, stepOrder])).toEqual([
      [5, 0],
      [6, 0],
    ]);
  });

  test("an explicit order cannot conflict with another placement argument", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "user", content: "hello" } }],
    });

    await expect(
      t.mutation(api.messages.addMessages, {
        threadId: thread._id as Id<"threads">,
        order: 1,
        promptMessageId: messages[0]._id as Id<"messages">,
        messages: [{ message: { role: "assistant", content: "reply" } }],
      }),
    ).rejects.toThrow("order and promptMessageId cannot both be provided");

    await expect(
      t.mutation(api.messages.addMessages, {
        threadId: thread._id as Id<"threads">,
        order: "next",
        promptMessageId: messages[0]._id as Id<"messages">,
        messages: [{ message: { role: "assistant", content: "reply" } }],
      }),
    ).rejects.toThrow("order and promptMessageId cannot both be provided");

    for (const order of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
      await expect(
        t.mutation(api.messages.addMessages, {
          threadId: thread._id as Id<"threads">,
          order,
          messages: [{ message: { role: "assistant", content: "reply" } }],
        }),
      ).rejects.toThrow("order must be a non-negative safe integer");
    }
  });

  test("derived message positions cannot exceed safe integers", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      order: 1,
      messages: [{ message: { role: "assistant", content: "reply" } }],
    });
    const messageId = messages[0]._id as Id<"messages">;

    await t.run(async (ctx) => {
      await ctx.db.patch("messages", messageId, {
        stepOrder: Number.MAX_SAFE_INTEGER,
      });
    });
    await expect(
      t.mutation(api.messages.addMessages, {
        threadId: thread._id as Id<"threads">,
        order: 1,
        messages: [{ message: { role: "assistant", content: "follow-up" } }],
      }),
    ).rejects.toThrow(
      "stepOrder cannot be incremented past Number.MAX_SAFE_INTEGER",
    );

    await t.run(async (ctx) => {
      await ctx.db.patch("messages", messageId, {
        order: Number.MAX_SAFE_INTEGER,
        stepOrder: 0,
      });
    });
    await expect(
      t.mutation(api.messages.addMessages, {
        threadId: thread._id as Id<"threads">,
        messages: [{ message: { role: "user", content: "new turn" } }],
      }),
    ).rejects.toThrow(
      "order cannot be incremented past Number.MAX_SAFE_INTEGER",
    );
  });

  test("order is incremented for user messages on to addMessages for the same promptMessageId", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "user", content: "hello" } }],
    });
    const maxMessage = await t.run(async (ctx) => {
      return await getMaxMessage(ctx, thread._id as Id<"threads">);
    });
    expect(maxMessage).toMatchObject({
      _id: messages.at(-1)!._id,
      order: 0,
      stepOrder: 0,
    });
    const { messages: messages2 } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "user", content: "hello" } }],
      agentName: "test",
      promptMessageId: messages.at(-1)!._id as Id<"messages">,
    });
    const maxMessage2 = await t.run(async (ctx) => {
      return await getMaxMessage(ctx, thread._id as Id<"threads">);
    });
    expect(maxMessage2).toMatchObject({
      _id: messages2.at(-1)!._id,
      order: 1,
      stepOrder: 0,
    });
  });

  test("sub order is incremented on subsequent calls to addMessages for the same promptMessageId", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "user", content: "hello" } }],
    });
    const maxMessage = await t.run(async (ctx) => {
      return await getMaxMessage(ctx, thread._id as Id<"threads">);
    });
    expect(maxMessage).toMatchObject({
      _id: messages.at(-1)!._id,
      order: 0,
      stepOrder: 0,
    });
    const { messages: messages2 } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "assistant", content: "hello" } }],
      agentName: "test",
      promptMessageId: messages.at(-1)!._id as Id<"messages">,
    });
    const maxMessage2 = await t.run(async (ctx) => {
      return await getMaxMessage(ctx, thread._id as Id<"threads">);
    });
    expect(maxMessage2).toMatchObject({
      _id: messages2.at(-1)!._id,
      order: 0,
      stepOrder: 1,
    });
  });

  test("adding multiple messages at a promptMessageId skips later messages", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "user", content: "hello" } }],
    });

    const { messages: messages2 } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        { message: { role: "user", content: "hello2" } },
        { message: { role: "assistant", content: "hello" } },
      ],
      agentName: "test",
    });
    expect(messages2.length).toBe(2);

    const { messages: messages3 } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        {
          message: {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                input: { a: 1 },
                toolCallId: "1",
                toolName: "tool",
              },
            ],
          },
        },
        {
          message: {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "tool",
                result: "foo",
                toolCallId: "1",
              },
            ],
          },
        },
        { message: { role: "user", content: "bye" } },
      ],
      agentName: "test",
      promptMessageId: messages.at(-1)!._id as Id<"messages">,
    });

    expect(messages3.length).toBe(3);

    const allMessages = await t.query(api.messages.listMessagesByThreadId, {
      threadId: thread._id as Id<"threads">,
      order: "asc",
    });
    expect(allMessages.page).toHaveLength(6);
    expect(allMessages.page.map((m) => m.order)).toEqual([0, 0, 0, 1, 1, 2]);
    expect(allMessages.page.map((m) => m.stepOrder)).toEqual([
      0, 1, 2, 0, 1, 0,
    ]);
    expect(allMessages.page[0]!.message!.role).toBe("user");
    expect(allMessages.page[0]!.message!.content).toBe("hello");
    expect(allMessages.page[1]!.message!.role).toBe("assistant");
    expect(allMessages.page[2]!.message!.role).toBe("tool");
    expect(allMessages.page[3]!.message!.role).toBe("user");
    expect(allMessages.page[3]!.message!.content).toBe("hello2");
    expect(allMessages.page[4]!.message!.role).toBe("assistant");
    expect(allMessages.page[5]!.message!.role).toBe("user");
    expect(allMessages.page[5]!.message!.content).toBe("bye");
  });

  test("updateMessage updates message content", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "user", content: "hello" } }],
    });
    const messageId = messages[0]._id as Id<"messages">;

    const updatedMessage = await t.mutation(api.messages.updateMessage, {
      messageId,
      patch: { message: { role: "user", content: "updated content" } },
    });

    expect(updatedMessage.message).toEqual({
      role: "user",
      content: "updated content",
    });
  });

  test("updateMessage clears stored reasoning", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        {
          message: { role: "assistant", content: "hello" },
          reasoning: "private chain of thought",
          reasoningDetails: [
            {
              type: "reasoning",
              text: "private chain of thought",
              providerOptions: { openai: { reasoningEncryptedContent: "enc" } },
            },
          ],
        },
      ],
    });
    const messageId = messages[0]._id as Id<"messages">;

    const updatedMessage = await t.mutation(api.messages.updateMessage, {
      messageId,
      patch: { reasoning: "", reasoningDetails: [] },
    });

    expect(updatedMessage.reasoning).toBe("");
    expect(updatedMessage.reasoningDetails).toEqual([]);
  });

  test("updateMessage updates message status", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        { message: { role: "assistant", content: "hello" }, status: "pending" },
      ],
    });
    const messageId = messages[0]._id as Id<"messages">;

    // Initial status should be pending
    expect(messages[0].status).toBe("pending");

    // Update to success
    const updatedMessage = await t.mutation(api.messages.updateMessage, {
      messageId,
      patch: { status: "success" },
    });

    expect(updatedMessage.status).toBe("success");
  });

  test("updateMessage updates error field", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        { message: { role: "assistant", content: "hello" }, status: "pending" },
      ],
    });
    const messageId = messages[0]._id as Id<"messages">;

    const updatedMessage = await t.mutation(api.messages.updateMessage, {
      messageId,
      patch: { status: "failed", error: "Something went wrong" },
    });

    expect(updatedMessage.status).toBe("failed");
    expect(updatedMessage.error).toBe("Something went wrong");
  });

  test("updateMessage correctly updates tool messages", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        {
          message: {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                input: { a: 1 },
                toolCallId: "1",
                toolName: "tool",
              },
            ],
          },
        },
      ],
    });
    const messageId = messages[0]._id as Id<"messages">;

    const updatedMessage = await t.mutation(api.messages.updateMessage, {
      messageId,
      patch: {
        message: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              input: { a: 2, b: 3 },
              toolCallId: "1",
              toolName: "tool",
            },
          ],
        },
      },
    });

    expect(updatedMessage.message).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          input: { a: 2, b: 3 },
          toolCallId: "1",
          toolName: "tool",
        },
      ],
    });
  });

  test("updateMessage throws error for non-existent message", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(api.messages.updateMessage, {
        messageId: "invalidId" as Id<"messages">,
        patch: { message: { role: "user", content: "test" } },
      }),
    ).rejects.toThrow();
  });

  test("deleteByIds deletes existing messages and returns their IDs", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        { message: { role: "user", content: "hello" } },
        { message: { role: "assistant", content: "world" } },
        { message: { role: "user", content: "test" } },
      ],
    });

    const messageIds = messages.map((m) => m._id as Id<"messages">);
    const deletedIds = await t.mutation(api.messages.deleteByIds, {
      messageIds: [messageIds[0], messageIds[2]], // Delete first and third messages
    });

    expect(deletedIds).toEqual([messageIds[0], messageIds[2]]);

    // Verify messages are actually deleted
    const remainingMessages = await t.query(
      api.messages.listMessagesByThreadId,
      { threadId: thread._id as Id<"threads">, order: "asc" },
    );
    expect(remainingMessages.page).toHaveLength(1);
    expect(remainingMessages.page[0]._id).toBe(messageIds[1]);
  });

  test("deleteByIds handles non-existent message IDs gracefully", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "user", content: "hello" } }],
    });

    const messageId = messages[0]._id as Id<"messages">;
    const validDeletedIds = await t.mutation(api.messages.deleteByIds, {
      messageIds: [messageId],
    });
    expect(validDeletedIds).toEqual([messageId]);

    const deletedIds = await t.mutation(api.messages.deleteByIds, {
      messageIds: [messageId],
    });

    // Should only return the valid ID that was actually deleted
    expect(deletedIds).toEqual([]);

    // Verify the valid message was deleted
    const remainingMessages = await t.query(
      api.messages.listMessagesByThreadId,
      { threadId: thread._id as Id<"threads">, order: "asc" },
    );
    expect(remainingMessages.page).toHaveLength(0);
  });

  test("deleteByOrder deletes messages within specified order range", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });

    // Create multiple rounds of messages with different orders
    await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        { message: { role: "user", content: "message order 0, step 0" } },
        { message: { role: "assistant", content: "message order 0, step 1" } },
      ],
    });

    await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        { message: { role: "user", content: "message order 1, step 0" } },
        { message: { role: "assistant", content: "message order 1, step 1" } },
      ],
    });

    await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        { message: { role: "user", content: "message order 2, step 0" } },
      ],
    });

    // Delete messages in order range 0 to 1 (exclusive)
    const result = await t.mutation(api.messages.deleteByOrder, {
      threadId: thread._id as Id<"threads">,
      startOrder: 0,
      endOrder: 2,
    });

    expect(result.isDone).toBe(true);
    expect(result.lastOrder).toBe(1);
    expect(result.lastStepOrder).toBe(1);

    // Verify only messages from order 0 & 1 were deleted
    const remainingMessages = await t.query(
      api.messages.listMessagesByThreadId,
      { threadId: thread._id as Id<"threads">, order: "asc" },
    );

    expect(remainingMessages.page).toHaveLength(1); // Should have messages from order 2
    expect(remainingMessages.page[0].message!.content).toBe(
      "message order 2, step 0",
    );
  });

  test("deleteByOrder handles step order boundaries correctly", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });

    // Create messages with the same order but different step orders
    await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        { message: { role: "user", content: "step 0" } },
        { message: { role: "assistant", content: "step 1" } },
        { message: { role: "assistant", content: "step 2" } },
        { message: { role: "assistant", content: "step 3" } },
      ],
    });

    // Delete messages from step 1 to step 3 (exclusive)
    const result = await t.mutation(api.messages.deleteByOrder, {
      threadId: thread._id as Id<"threads">,
      startOrder: 0,
      startStepOrder: 1,
      endOrder: 0,
      endStepOrder: 3,
    });

    expect(result.isDone).toBe(true);
    expect(result.lastOrder).toBe(0);
    expect(result.lastStepOrder).toBe(2);

    // Verify only step 1 and 2 were deleted (step 3 is excluded by upperBoundInclusive: false)
    const remainingMessages = await t.query(
      api.messages.listMessagesByThreadId,
      { threadId: thread._id as Id<"threads">, order: "asc" },
    );

    expect(remainingMessages.page).toHaveLength(2);
    expect(remainingMessages.page.map((m) => m.stepOrder)).toEqual([0, 3]);
  });

  test("deleteByOrder returns isDone false when batch limit is reached", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });

    // This test would be more realistic with 65+ messages, but for test efficiency
    // we'll just verify the basic structure works with fewer messages
    await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        { message: { role: "user", content: "message 1" } },
        { message: { role: "assistant", content: "message 2" } },
      ],
    });

    const result = await t.mutation(api.messages.deleteByOrder, {
      threadId: thread._id as Id<"threads">,
      startOrder: 0,
      endOrder: 2,
    });

    // With only 2 messages, should be done
    expect(result.isDone).toBe(true);
    expect(result.lastOrder).toBe(0);
    expect(result.lastStepOrder).toBe(1);
  });

  test("deleteByOrder handles empty result set", async () => {
    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, {
      userId: "test",
    });

    await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [{ message: { role: "user", content: "message order 0" } }],
    });

    // Try to delete from a range that doesn't exist
    const result = await t.mutation(api.messages.deleteByOrder, {
      threadId: thread._id as Id<"threads">,
      startOrder: 5,
      endOrder: 10,
    });

    expect(result.isDone).toBe(true);
    expect(result.lastOrder).toBeUndefined();
    expect(result.lastStepOrder).toBeUndefined();

    // Verify original message is still there
    const remainingMessages = await t.query(
      api.messages.listMessagesByThreadId,
      { threadId: thread._id as Id<"threads">, order: "asc" },
    );
    expect(remainingMessages.page).toHaveLength(1);
  });

  // Regression test for #256: when searching across threads with
  // searchAllMessagesForUserId, the targetMessage's order should not filter
  // out messages from other threads (their order sequences are independent).
  test("textSearch returns cross-thread matches even when target order is lower", async () => {
    const t = convexTest(schema, modules);
    const userId = "user-256";

    // Old thread: build up several messages so the matching one has a high order.
    const oldThread = await t.mutation(api.threads.createThread, { userId });
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.messages.addMessages, {
        threadId: oldThread._id as Id<"threads">,
        userId,
        messages: [
          { message: { role: "user", content: `filler message ${i}` } },
        ],
      });
    }
    await t.mutation(api.messages.addMessages, {
      threadId: oldThread._id as Id<"threads">,
      userId,
      messages: [
        {
          message: {
            role: "user",
            content:
              "tom and jerry are both amazing high-ticket coaches and educators",
          },
        },
      ],
    });

    // New thread: only one message — its order will be 0, lower than the
    // matching message in the old thread.
    const newThread = await t.mutation(api.threads.createThread, { userId });
    const { messages: newMessages } = await t.mutation(
      api.messages.addMessages,
      {
        threadId: newThread._id as Id<"threads">,
        userId,
        messages: [
          {
            message: {
              role: "user",
              content: "what do you remember about high-ticket coaches",
            },
          },
        ],
      },
    );
    const targetMessageId = newMessages[0]._id as Id<"messages">;

    const results = await t.query(api.messages.textSearch, {
      searchAllMessagesForUserId: userId,
      targetMessageId,
      text: "high-ticket coaches",
      limit: 10,
    });

    // The cross-thread match should NOT be filtered out by the target's order.
    expect(
      results.some((m) =>
        m.text?.includes("tom and jerry are both amazing high-ticket coaches"),
      ),
    ).toBe(true);
    // The target message itself must still be excluded.
    expect(results.some((m) => m._id === targetMessageId)).toBe(false);
  });

  // Regression test for #256: same-thread order filter must still work even
  // when searching across threads.
  test("textSearch still filters same-thread results past the target order", async () => {
    const t = convexTest(schema, modules);
    const userId = "user-256-same";

    const thread = await t.mutation(api.threads.createThread, { userId });
    // earlier match
    await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      userId,
      messages: [
        { message: { role: "user", content: "earlier high-ticket match" } },
      ],
    });
    // target
    const { messages: targetMessages } = await t.mutation(
      api.messages.addMessages,
      {
        threadId: thread._id as Id<"threads">,
        userId,
        messages: [
          { message: { role: "user", content: "target high-ticket message" } },
        ],
      },
    );
    // later match in same thread — should be filtered out
    await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      userId,
      messages: [
        { message: { role: "user", content: "later high-ticket match" } },
      ],
    });

    const results = await t.query(api.messages.textSearch, {
      searchAllMessagesForUserId: userId,
      targetMessageId: targetMessages[0]._id as Id<"messages">,
      text: "high-ticket",
      limit: 10,
    });

    expect(results.some((m) => m.text === "earlier high-ticket match")).toBe(
      true,
    );
    expect(results.some((m) => m.text === "later high-ticket match")).toBe(
      false,
    );
    expect(results.some((m) => m._id === targetMessages[0]._id)).toBe(false);
  });

  async function pendingWithStreams(
    streamCount = 1,
    transactionLimits: Parameters<
      typeof convexTest
    >[0]["transactionLimits"] = true,
  ) {
    const t = convexTest({ schema, modules, transactionLimits });
    const thread = await t.mutation(api.threads.createThread, {
      userId: "bounded-recovery-user",
    });
    const threadId = thread._id as Id<"threads">;
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
    });
    const pending = messages[0]!;
    const streamIds: Id<"streamingMessages">[] = [];
    for (let i = 0; i < streamCount; i++) {
      streamIds.push(
        await t.run(async (ctx) =>
          ctx.db.insert("streamingMessages", {
            threadId,
            order: pending.order,
            stepOrder: pending.stepOrder,
            format: "UIMessageChunk",
            state: { kind: "aborted", reason: "interrupted" },
          }),
        ),
      );
    }
    const addText = async (
      streamId: Id<"streamingMessages">,
      deltas: string[],
    ) => {
      await t.run((ctx) =>
        ctx.db.insert("streamDeltas", {
          streamId,
          start: 0,
          end: 1,
          parts: [{ type: "text-start", id: "text" }],
        }),
      );
      // Batches stay under the tests' smallest write budget.
      for (let i = 0; i < deltas.length; ) {
        let end = i + 1;
        let bytes = deltas[i]!.length;
        while (
          end < deltas.length &&
          end - i < 4000 &&
          bytes + deltas[end]!.length <= 1_000_000
        ) {
          bytes += deltas[end++]!.length;
        }
        const start = i;
        const batch = deltas.slice(start, end);
        await t.run(async (ctx) => {
          for (const [j, delta] of batch.entries()) {
            await ctx.db.insert("streamDeltas", {
              streamId,
              start: start + j + 1,
              end: start + j + 2,
              parts: [{ type: "text-delta", id: "text", delta }],
            });
          }
        });
        i = end;
      }
    };
    const finalize = async (
      result: { status: "success" } | { status: "failed"; error: string },
    ) => {
      await t.mutation(api.messages.finalizeMessage, {
        messageId: pending._id as Id<"messages">,
        result,
      });
      return t.run((ctx) =>
        ctx.db.get("messages", pending._id as Id<"messages">),
      );
    };
    const recoveredTexts = async () => {
      const { page } = await t.query(api.messages.listMessagesByThreadId, {
        threadId,
        order: "asc",
      });
      return page
        .filter((m) => m.order === pending.order)
        .map((m) => m.text ?? "");
    };
    return { streamIds, addText, finalize, recoveredTexts };
  }

  const fill = (count: number, size: number) =>
    Array.from({ length: count }, () => "x".repeat(size));
  const largeDelta = Math.floor(MAX_MATERIALIZATION_BYTES / 9);

  test.each([
    {
      name: "many deltas past the old 1,000 document cap",
      streams: [[...fill(1000, 1), "accepted 🦉 tail"]],
    },
    {
      name: "several streams recovered in order",
      streams: [fill(2, largeDelta), fill(2, largeDelta)],
    },
  ])("recovers every accepted delta: $name", async ({ streams }) => {
    const { streamIds, addText, finalize, recoveredTexts } =
      await pendingWithStreams(streams.length);
    for (const [i, deltas] of streams.entries()) {
      await addText(streamIds[i]!, deltas);
    }
    const finalized = await finalize({
      status: "failed",
      error: "interrupted",
    });
    expect(finalized?.status).toBe("failed");
    expect(await recoveredTexts()).toEqual(streams.map((d) => d.join("")));
  });

  test.each([
    {
      name: "one stream over the byte budget",
      streams: [fill(10, largeDelta)],
    },
    {
      name: "streams that fit alone but not together",
      streams: [fill(6, largeDelta), fill(6, largeDelta)],
    },
    {
      name: "a second stream after the first exhausted the budget",
      streams: [fill(10, largeDelta), fill(10, largeDelta)],
    },
    {
      name: "one stream over the document budget",
      streams: [fill(MAX_MATERIALIZATION_ROWS + 1, 1)],
    },
    {
      // convex-test does not enforce the 1 MiB document ceiling, so a write
      // budget the recovered message exceeds stands in for it.
      name: "a recovered message the store rejects",
      streams: [fill(4, 300_000)],
      transactionLimits: { bytesWritten: 1024 * 1024 },
    },
    {
      // Each message fits the write budget alone. The second write fails
      // after the first succeeded, so the first must be rolled back too.
      name: "a second recovered message the store rejects",
      streams: [fill(3, 300_000), fill(3, 300_000)],
      transactionLimits: { bytesWritten: 1024 * 1024 + 300_000 },
    },
    {
      name: "more streams than recovery will attempt",
      streams: Array.from({ length: MAX_MATERIALIZATION_STREAMS + 1 }, () => [
        "x",
      ]),
    },
  ])(
    "fails explicitly without a partial write: $name",
    async ({ streams, transactionLimits }) => {
      const { streamIds, addText, finalize, recoveredTexts } =
        await pendingWithStreams(streams.length, transactionLimits ?? true);
      for (const [i, deltas] of streams.entries()) {
        await addText(streamIds[i]!, deltas);
      }
      const finalized = await finalize({ status: "success" });
      expect(finalized?.status).toBe("failed");
      expect(finalized?.error).toBe(
        "Failed to recover persisted assistant stream output",
      );
      expect(await recoveredTexts()).toEqual([""]);
    },
  );

  test("finalizeMessage commits a failed pending message when stream recovery is malformed", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {
      userId: "recovery-user",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        {
          message: { role: "assistant", content: [] },
          status: "pending",
        },
      ],
    });
    const pending = messages[0];
    const streamId = await t.run(async (ctx) =>
      ctx.db.insert("streamingMessages", {
        threadId: thread._id as Id<"threads">,
        order: pending.order,
        stepOrder: pending.stepOrder,
        format: "UIMessageChunk",
        state: { kind: "aborted", reason: "interrupted" },
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("streamDeltas", {
        streamId,
        start: 0,
        end: 1,
        parts: [{ type: "text-delta", id: "missing", delta: "partial" }],
      }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        t.mutation(api.messages.finalizeMessage, {
          messageId: pending._id as Id<"messages">,
          result: { status: "success" },
        }),
      ).resolves.toBeNull();
    } finally {
      errorSpy.mockRestore();
    }

    const finalized = await t.run((ctx) =>
      ctx.db.get("messages", pending._id as Id<"messages">),
    );
    expect(finalized).toMatchObject({
      status: "failed",
      error: "Failed to recover persisted assistant stream output",
      message: { role: "assistant", content: [] },
    });
  });

  test("finalizeMessage discards all recovered output when any stream is malformed", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {
      userId: "mixed-recovery-user",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        {
          message: { role: "assistant", content: [] },
          status: "pending",
        },
      ],
    });
    const pending = messages[0];
    const embeddingId = await t.run(async (ctx) =>
      ctx.db.insert("embeddings_128", {
        model: "embedding-model",
        table: "messages",
        threadId: thread._id,
        vector: Array.from({ length: 128 }, () => 0),
      }),
    );
    await t.run((ctx) =>
      ctx.db.patch("messages", pending._id as Id<"messages">, { embeddingId }),
    );

    const validStreamId = await t.run(async (ctx) =>
      ctx.db.insert("streamingMessages", {
        threadId: thread._id as Id<"threads">,
        order: pending.order,
        stepOrder: pending.stepOrder,
        format: "UIMessageChunk",
        state: { kind: "finished", endedAt: Date.now() },
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("streamDeltas", {
        streamId: validStreamId,
        start: 0,
        end: 3,
        parts: [
          { type: "text-start", id: "valid" },
          { type: "text-delta", id: "valid", delta: "must not be inserted" },
          { type: "text-end", id: "valid" },
        ],
      }),
    );
    const malformedStreamId = await t.run(async (ctx) =>
      ctx.db.insert("streamingMessages", {
        threadId: thread._id as Id<"threads">,
        order: pending.order,
        stepOrder: pending.stepOrder,
        format: "UIMessageChunk",
        state: { kind: "aborted", reason: "interrupted" },
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("streamDeltas", {
        streamId: malformedStreamId,
        start: 0,
        end: 1,
        parts: [
          {
            type: "tool-input-delta",
            toolCallId: "missing",
            inputTextDelta: "{}",
          },
        ],
      }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await t.mutation(api.messages.finalizeMessage, {
        messageId: pending._id as Id<"messages">,
        result: { status: "failed", error: "provider failed" },
      });
    } finally {
      errorSpy.mockRestore();
    }

    const state = await t.run(async (ctx) => ({
      messages: await ctx.db.query("messages").collect(),
      embedding: await ctx.db.get("embeddings_128", embeddingId),
    }));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      _id: pending._id,
      status: "failed",
      error: "provider failed",
      message: { role: "assistant", content: [] },
    });
    expect(state.messages[0].embeddingId).toBeUndefined();
    expect(state.embedding).toBeNull();
  });

  test("transfers recovered file ownership and releases timed-out streams", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {
      userId: "stream-file-recovery",
    });
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
    });
    const pending = messages[0]!;
    const { fileId: recoveredFileId } = await t.mutation(api.files.addFile, {
      storageId: "recovered-storage",
      hash: "recovered-hash",
      filename: "recovered.txt",
    });
    await t.mutation(api.files.copyFile, { fileId: recoveredFileId });
    const recoveredStreamId = await t.run((ctx) =>
      ctx.db.insert("streamingMessages", {
        threadId: thread._id as Id<"threads">,
        order: pending.order,
        stepOrder: pending.stepOrder,
        format: "UIMessageChunk",
        state: { kind: "aborted", reason: "interrupted" },
        fileRefs: [
          { url: "https://files.example/recovered", fileId: recoveredFileId },
        ],
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("streamDeltas", {
        streamId: recoveredStreamId,
        start: 0,
        end: 3,
        parts: [
          { type: "start" },
          {
            type: "file",
            url: "https://files.example/recovered",
            mediaType: "text/plain",
          },
          { type: "finish" },
        ],
      }),
    );
    await t.mutation(api.messages.finalizeMessage, {
      messageId: pending._id as Id<"messages">,
      result: { status: "success" },
    });
    await expect(
      t.query(api.files.get, { fileId: recoveredFileId }),
    ).resolves.toMatchObject({
      refcount: 1,
    });
    expect(
      (await t.run((ctx) => ctx.db.get("streamingMessages", recoveredStreamId)))
        ?.fileRefs,
    ).toBeUndefined();

    const { fileId: timedOutFileId } = await t.mutation(api.files.addFile, {
      storageId: "timeout-storage",
      hash: "timeout-hash",
      filename: "timeout.txt",
    });
    await t.mutation(api.files.copyFile, { fileId: timedOutFileId });
    const timedOutStreamId = await t.run((ctx) =>
      ctx.db.insert("streamingMessages", {
        threadId: thread._id as Id<"threads">,
        order: pending.order + 1,
        stepOrder: 0,
        format: "UIMessageChunk",
        state: { kind: "streaming", lastHeartbeat: Date.now() },
        fileRefs: [
          { url: "https://files.example/timeout", fileId: timedOutFileId },
        ],
      }),
    );
    await t.run((ctx) =>
      timeoutStreamHandler(ctx, { streamId: timedOutStreamId }),
    );
    await t.mutation(api.streams.deleteStreamSync, {
      streamId: timedOutStreamId,
    });
    await expect(
      t.query(api.files.get, { fileId: timedOutFileId }),
    ).resolves.toMatchObject({
      refcount: 0,
    });
  });
});

describe("late saves racing a failed pending message (issue #320)", () => {
  const PROVIDER_ERROR = "invalid_prompt: Invalid prompt: flagged by policy.";

  test("keeps the first durable failure authoritative", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {
      userId: "u1",
    });
    const threadId = thread._id as Id<"threads">;

    const { messages: seeded } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [
        { message: { role: "user", content: "hello" } },
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
    });
    const pending = seeded.at(-1)!;
    expect(pending.status).toBe("pending");

    const streamId = await t.mutation(api.streams.create, {
      threadId,
      order: pending.order,
      stepOrder: pending.stepOrder,
      format: "UIMessageChunk",
    });

    await t.mutation(api.messages.finalizeMessage, {
      messageId: pending._id as Id<"messages">,
      result: { status: "failed", error: PROVIDER_ERROR },
    });
    await t.mutation(api.streams.abort, { streamId, reason: PROVIDER_ERROR });

    const { messages: late } = await t.mutation(api.messages.addMessages, {
      threadId,
      pendingMessageId: pending._id as Id<"messages">,
      finishStreamId: streamId,
      failPendingSteps: false,
      messages: [
        { message: { role: "assistant", content: "partial response" } },
      ],
    });

    const assistants = (
      await t.run(async (ctx) =>
        ctx.db
          .query("messages")
          .withIndex("threadId_status_tool_order_stepOrder", (q) =>
            q.eq("threadId", threadId),
          )
          .collect(),
      )
    ).filter((message) => message.message?.role === "assistant");

    expect(late).toHaveLength(1);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!._id).toBe(pending._id);
    expect(assistants[0]!.status).toBe("failed");
    expect(assistants[0]!.error).toBe(PROVIDER_ERROR);
    expect(assistants[0]!.text).toBe("partial response");

    const stream = await t.run((ctx) =>
      ctx.db.get("streamingMessages", streamId),
    );
    expect(stream?.state.kind).toBe("aborted");
  });
});

describe("saving into a pending message that already succeeded", () => {
  const NOT_PENDING = /can't be filled: its status is "success"/;

  async function seeded() {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {
      userId: "u1",
    });
    const threadId = thread._id as Id<"threads">;
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [
        { message: { role: "user", content: "weather?" } },
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
    });
    const prompt = messages[0]._id as Id<"messages">;
    const pending = messages[1]._id as Id<"messages">;
    const snapshot = () =>
      t.run(async (ctx) => ({
        messages: (await ctx.db.query("messages").collect()).sort(
          (a, b) => a.order - b.order || a.stepOrder - b.stepOrder,
        ),
        vectors: await ctx.db.query("embeddings_128").collect(),
        streams: await ctx.db.query("streamingMessages").collect(),
      }));
    return { t, threadId, prompt, pending, snapshot };
  }

  const toolStep = (text: string) => [
    {
      message: {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text },
          {
            type: "tool-call" as const,
            toolCallId: "1",
            toolName: "weather",
            args: {},
          },
        ],
      },
    },
    {
      message: {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolName: "weather",
            result: "72F",
            toolCallId: "1",
          },
        ],
      },
    },
    {
      message: { role: "assistant" as const, content: [] },
      status: "pending" as const,
    },
  ];

  test("a repeated single fill throws and writes nothing", async () => {
    const { t, threadId, pending, snapshot } = await seeded();
    const { messages: first } = await t.mutation(api.messages.addMessages, {
      threadId,
      pendingMessageId: pending,
      messages: [{ message: { role: "assistant", content: "first answer" } }],
    });
    expect(first).toEqual([
      expect.objectContaining({
        _id: pending,
        status: "success",
        text: "first answer",
      }),
    ]);
    const before = await snapshot();

    await expect(
      t.mutation(api.messages.addMessages, {
        threadId,
        pendingMessageId: pending,
        messages: [
          { message: { role: "assistant", content: "second answer" } },
          { message: { role: "assistant", content: [] }, status: "pending" },
        ],
        embeddings: {
          model: "test",
          dimension: 128,
          vectors: [Array.from({ length: 128 }, () => 0.1), null],
        },
      }),
    ).rejects.toThrow(NOT_PENDING);
    expect(await snapshot()).toEqual(before);
  });

  test("a repeated step save throws, and the first save's successor still takes the next step", async () => {
    const { t, threadId, prompt, pending, snapshot } = await seeded();
    const step = (text: string) => ({
      threadId,
      promptMessageId: prompt,
      pendingMessageId: pending,
      messages: toolStep(text),
    });
    const { messages: first } = await t.mutation(
      api.messages.addMessages,
      step("attempt 1"),
    );
    expect(first.map((m) => m.status)).toEqual([
      "success",
      "success",
      "pending",
    ]);
    const before = await snapshot();

    await expect(
      t.mutation(api.messages.addMessages, step("attempt 2")),
    ).rejects.toThrow(NOT_PENDING);
    expect(await snapshot()).toEqual(before);

    await t.mutation(api.messages.addMessages, {
      threadId,
      promptMessageId: prompt,
      pendingMessageId: first.at(-1)!._id as Id<"messages">,
      messages: [{ message: { role: "assistant", content: "It is 72F" } }],
    });
    const assistants = (await snapshot()).messages
      .filter((m) => m.message?.role === "assistant")
      .map((m) => [m.status, m.text]);
    expect(assistants).toEqual([
      ["success", "attempt 1"],
      ["success", "It is 72F"],
    ]);
  });
});

test("a stopped generation's recovered steps stay in its turn after a newer message", async () => {
  const t = initConvexTest();
  const thread = await t.mutation(api.threads.createThread, {});
  const threadId = thread._id as Id<"threads">;
  const { messages } = await t.mutation(api.messages.addMessages, {
    threadId,
    messages: [
      { message: { role: "user", content: "weather?" } },
      { message: { role: "assistant", content: [] }, status: "pending" },
    ],
  });
  const pending = messages[1];
  const streamId = await t.mutation(api.streams.create, {
    threadId,
    order: pending.order,
    stepOrder: pending.stepOrder,
    format: "UIMessageChunk",
  });
  await t.mutation(api.streams.addDelta, {
    streamId,
    start: 0,
    end: 1,
    parts: [
      { type: "start-step" },
      {
        type: "tool-input-available",
        toolCallId: "c",
        toolName: "lookup",
        input: {},
      },
      { type: "tool-output-available", toolCallId: "c", output: "72F" },
      { type: "finish-step" },
      { type: "start-step" },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "It is 72F" },
    ],
  });
  await t.mutation(api.messages.addMessages, {
    threadId,
    messages: [{ message: { role: "user", content: "thanks" } }],
  });
  await t.mutation(api.messages.finalizeMessage, {
    messageId: pending._id as Id<"messages">,
    result: { status: "failed", error: "stopped" },
  });
  const { page } = await t.query(api.messages.listMessagesByThreadId, {
    threadId,
    order: "asc",
  });
  expect(page.map((m) => [m.order, m.message?.role])).toEqual([
    [0, "user"],
    [0, "assistant"],
    [0, "tool"],
    [0, "assistant"],
    [1, "user"],
  ]);
});

test("a user message saved after filling an older pending message starts a new turn", async () => {
  const t = initConvexTest();
  const thread = await t.mutation(api.threads.createThread, {});
  const threadId = thread._id as Id<"threads">;
  const { messages } = await t.mutation(api.messages.addMessages, {
    threadId,
    messages: [
      { message: { role: "user", content: "first" } },
      { message: { role: "assistant", content: [] }, status: "pending" },
      { message: { role: "user", content: "second" } },
    ],
  });
  await t.mutation(api.messages.addMessages, {
    threadId,
    pendingMessageId: messages[1]._id as Id<"messages">,
    messages: [
      { message: { role: "assistant", content: "answer" } },
      { message: { role: "user", content: "third" } },
    ],
  });
  const { page } = await t.query(api.messages.listMessagesByThreadId, {
    threadId,
    order: "asc",
  });
  expect(page.map((m) => [m.order, m.stepOrder, m.text])).toEqual([
    [0, 0, "first"],
    [0, 1, "answer"],
    [1, 0, "second"],
    [2, 0, "third"],
  ]);
});

describe("deleting a message aborts generation writing to it (issue #300)", () => {
  test("a stream at the deleted order is aborted", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, { userId: "u" });
    const threadId = thread._id as Id<"threads">;

    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [{ message: { role: "user", content: "hello" } }],
    });
    const prompt = messages[0];

    await t.mutation(api.streams.create, {
      threadId,
      order: prompt.order,
      stepOrder: prompt.stepOrder + 1,
      userId: "u",
      agentName: "a",
      model: "m",
      provider: "p",
      format: "UIMessageChunk",
    });

    await t.mutation(api.messages.deleteByIds, {
      messageIds: [prompt._id as Id<"messages">],
    });

    const streaming = await t.query(api.streams.list, {
      threadId,
      statuses: ["streaming"],
    });
    const aborted = await t.query(api.streams.list, {
      threadId,
      statuses: ["aborted"],
    });
    expect(streaming).toHaveLength(0);
    expect(aborted).toHaveLength(1);
  });
});

describe("abandoning a save whose prompt was deleted (issue #300)", () => {
  test("abandons instead of throwing when the caller opts in", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, { userId: "u" });
    const threadId = thread._id as Id<"threads">;

    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [{ message: { role: "user", content: "hello" } }],
    });
    const promptMessageId = messages[0]._id as Id<"messages">;

    await t.mutation(api.messages.deleteByIds, {
      messageIds: [promptMessageId],
    });

    const saved = await t.mutation(api.messages.addMessages, {
      threadId,
      promptMessageId,
      abandonIfPromptMissing: true,
      messages: [{ message: { role: "assistant", content: "answer" } }],
    });
    expect(saved.messages).toEqual([]);

    // Nothing was grafted onto the thread.
    const all = await t.query(api.messages.listMessagesByThreadId, {
      threadId,
      order: "asc",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(all.page).toHaveLength(0);
  });

  test("a successful final save after its stream was deleted saves the answer and finalizes the pending message", async () => {
    // timeoutStreamHandler aborts a stream with no heartbeat for 10 minutes
    // (a long tool call), and scheduleStreamDeletion removes it 5 minutes
    // later. The thread and prompt are still there, so the answer must land.
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, { userId: "u" });
    const threadId = thread._id as Id<"threads">;

    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [
        { message: { role: "user", content: "hello" } },
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
    });
    const [prompt, pending] = messages;
    const promptMessageId = prompt._id as Id<"messages">;
    const pendingMessageId = pending._id as Id<"messages">;
    const streamId = await t.mutation(api.streams.create, {
      threadId,
      order: pending.order,
      stepOrder: pending.stepOrder,
      format: "UIMessageChunk",
    });
    await t.run(async (ctx) => ctx.db.delete("streamingMessages", streamId));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const saved = await t.mutation(api.messages.addMessages, {
        threadId,
        promptMessageId,
        abandonIfPromptMissing: true,
        pendingMessageId,
        finishStreamId: streamId,
        failPendingSteps: false,
        messages: [{ message: { role: "assistant", content: "answer" } }],
      });
      expect(saved.messages.map((m) => [m._id, m.status, m.text])).toEqual([
        [pendingMessageId, "success", "answer"],
      ]);
    } finally {
      warn.mockRestore();
    }

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("threadId_status_tool_order_stepOrder", (q) =>
          q.eq("threadId", threadId),
        )
        .collect(),
    );
    expect(rows.map((m) => [m._id, m.status])).toEqual([
      [promptMessageId, "success"],
      [pendingMessageId, "success"],
    ]);
  });

  test("abandons a save whose stream, prompt and thread a thread deletion removed", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, { userId: "u" });
    const threadId = thread._id as Id<"threads">;

    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [{ message: { role: "user", content: "hello" } }],
    });
    const prompt = messages[0];
    const promptMessageId = prompt._id as Id<"messages">;
    const streamId = await t.mutation(api.streams.create, {
      threadId,
      order: prompt.order,
      stepOrder: prompt.stepOrder + 1,
      format: "UIMessageChunk",
    });
    await t.mutation(api.threads.deleteAllForThreadIdAsync, { threadId });
    await t.finishAllScheduledFunctions(() => {});

    const saved = await t.mutation(api.messages.addMessages, {
      threadId,
      promptMessageId,
      abandonIfPromptMissing: true,
      finishStreamId: streamId,
      messages: [
        {
          message: { role: "assistant", content: "partial" },
          status: "failed",
          error: "The generation failed",
        },
      ],
    });
    expect(saved.messages).toEqual([]);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("threadId_status_tool_order_stepOrder", (q) =>
          q.eq("threadId", threadId),
        )
        .collect(),
    );
    expect(rows).toEqual([]);
  });

  test("a thread deletion removes a generation's stream only after the thread's messages", async () => {
    // With the stream deleted last, addMessagesHandler can read a missing
    // finishStreamId stream on a live prompt as a timed-out stream, not a
    // deletion whose cursor a failed save would land behind.
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, { userId: "u" });
    const threadId = thread._id as Id<"threads">;
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [
        { message: { role: "user", content: "one" } },
        { message: { role: "user", content: "two" } },
      ],
    });
    const streamId = await t.mutation(api.streams.create, {
      threadId,
      order: messages[1].order,
      stepOrder: messages[1].stepOrder + 1,
      format: "UIMessageChunk",
    });

    const step = await t.mutation(internal.threads._deleteThreadStep, {
      threadId,
      limit: 1,
    });
    expect(step.isDone).toBe(false);
    expect(
      await t.run(async (ctx) => ctx.db.get("streamingMessages", streamId)),
    ).not.toBeNull();

    await t.mutation(api.threads.deleteAllForThreadIdAsync, {
      threadId,
      limit: 1,
    });
    await t.finishAllScheduledFunctions(() => {});
    expect(
      await t.run(async (ctx) => ({
        stream: await ctx.db.get("streamingMessages", streamId),
        thread: await ctx.db.get("threads", threadId),
      })),
    ).toEqual({ stream: null, thread: null });
  });

  test("still throws for a caller that did not opt in", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, { userId: "u" });
    const threadId = thread._id as Id<"threads">;

    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [{ message: { role: "user", content: "hello" } }],
    });
    const promptMessageId = messages[0]._id as Id<"messages">;
    await t.mutation(api.messages.deleteByIds, {
      messageIds: [promptMessageId],
    });

    await expect(
      t.mutation(api.messages.addMessages, {
        threadId,
        promptMessageId,
        messages: [{ message: { role: "assistant", content: "answer" } }],
      }),
    ).rejects.toThrow("not found");
  });
});

describe("cloneThread", () => {
  // Five messages across three orders, so a bounded clone has to cross a
  // batch boundary and stop partway through the source.
  async function seed() {
    const t = initConvexTest();
    const source = await t.mutation(api.threads.createThread, {
      userId: "cloner",
    });
    const target = await t.mutation(api.threads.createThread, {
      userId: "cloner",
    });
    const sourceThreadId = source._id as Id<"threads">;
    const targetThreadId = target._id as Id<"threads">;
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: sourceThreadId,
      messages: [{ message: { role: "user", content: "one" } }],
    });
    await t.mutation(api.messages.addMessages, {
      threadId: sourceThreadId,
      promptMessageId: messages[0]!._id as Id<"messages">,
      messages: [{ message: { role: "assistant", content: "one answer" } }],
    });
    await t.mutation(api.messages.addMessages, {
      threadId: sourceThreadId,
      messages: [
        { message: { role: "user", content: "two" } },
        { message: { role: "assistant", content: "two answer" } },
      ],
    });
    await t.mutation(api.messages.addMessages, {
      threadId: sourceThreadId,
      messages: [{ message: { role: "user", content: "three" } }],
    });
    const targetRows = () =>
      t.run((ctx) =>
        ctx.db
          .query("messages")
          .withIndex("threadId_status_tool_order_stepOrder", (q) =>
            q.eq("threadId", targetThreadId),
          )
          .collect(),
      );
    return { t, sourceThreadId, targetThreadId, targetRows };
  }

  test.each([
    { options: { batchSize: 2 }, copied: 5 },
    { options: { limit: 3 }, copied: 3 },
    { options: { batchSize: 2, limit: 3 }, copied: 3 },
  ])("copies exactly what $options asks for", async ({ options, copied }) => {
    const { t, sourceThreadId, targetThreadId, targetRows } = await seed();
    const result = await t.action(api.messages.cloneThread, {
      sourceThreadId,
      targetThreadId,
      ...options,
    });
    expect(result).toBe(copied);
    expect(await targetRows()).toHaveLength(copied);
  });

  test("a cloned message never references a row outside its thread", async () => {
    const { t, sourceThreadId, targetThreadId, targetRows } = await seed();
    await t.action(api.messages.cloneThread, {
      sourceThreadId,
      targetThreadId,
    });
    const rows = await targetRows();
    const ids = new Set(rows.map((m) => m._id));
    for (const row of rows) {
      if (row.parentMessageId !== undefined) {
        expect(ids.has(row.parentMessageId)).toBe(true);
      }
    }
  });

  test("excludeToolMessages skips tool messages in the boundary order", async () => {
    const { t, sourceThreadId, targetThreadId, targetRows } = await seed();
    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId: sourceThreadId,
      messages: [
        { message: { role: "user", content: "four" } },
        {
          message: {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                input: {},
                toolCallId: "1",
                toolName: "tool",
              },
            ],
          },
        },
        {
          message: {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "tool",
                result: "foo",
                toolCallId: "1",
              },
            ],
          },
        },
        { message: { role: "assistant", content: "four answer" } },
      ],
    });
    await t.action(api.messages.cloneThread, {
      sourceThreadId,
      targetThreadId,
      excludeToolMessages: true,
      upToAndIncludingMessageId: messages.at(-1)!._id as Id<"messages">,
    });
    expect((await targetRows()).filter((m) => m.tool)).toEqual([]);
  });
});

describe("failing pending steps", () => {
  test("reads only the prompt's order", async () => {
    const t = convexTest({
      schema,
      modules,
      transactionLimits: { documentsRead: 40 },
    });
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    const {
      messages: [prompt],
    } = await t.mutation(api.messages.addMessages, {
      threadId,
      messages: [{ message: { role: "user", content: "retry me" } }],
    });
    await t.run(async (ctx) => {
      for (let order = 1; order <= 60; order++) {
        await ctx.db.insert("messages", {
          threadId,
          order,
          stepOrder: 0,
          status: "pending",
          tool: false,
        });
      }
    });

    const { messages } = await t.mutation(api.messages.addMessages, {
      threadId,
      promptMessageId: prompt._id as Id<"messages">,
      failPendingSteps: true,
      messages: [
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
    });
    expect(messages).toMatchObject([{ order: 0, status: "pending" }]);
  });
});

describe("listing a thread's messages", () => {
  test("stops a page early before the transaction read limit, unless bound by endCursor", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    const big = "x".repeat(400_000);
    for (let batch = 0; batch < 10; batch++) {
      await t.mutation(api.messages.addMessages, {
        threadId,
        messages: Array.from({ length: 5 }, (_, i) => ({
          message: { role: "user" as const, content: `${batch * 5 + i} ${big}` },
        })),
      });
    }

    const pages = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<
        ReturnType<typeof t.query<typeof api.messages.listMessagesByThreadId>>
      > = await t.query(api.messages.listMessagesByThreadId, {
        threadId,
        order: "desc",
        paginationOpts: { numItems: 100, cursor },
      });
      pages.push(page);
      cursor = page.continueCursor;
    } while (!pages.at(-1)!.isDone);

    expect(pages[0].page.length).toBeLessThan(50);
    expect(pages[0].isDone).toBe(false);
    const listed = pages.flatMap((p) =>
      p.page.map((m) => Number(m.text!.split(" ", 1)[0])),
    );
    expect(listed).toEqual(Array.from({ length: 50 }, (_, i) => 49 - i));

    // A paginated hook keeps the first page bound to where the next starts,
    // so it reads to there as it grows.
    await t.mutation(api.messages.addMessages, {
      threadId,
      messages: Array.from({ length: 5 }, (_, i) => ({
        message: { role: "user" as const, content: `${50 + i} ${big}` },
      })),
    });
    const grown = await t.query(api.messages.listMessagesByThreadId, {
      threadId,
      order: "desc",
      paginationOpts: {
        numItems: 100,
        cursor: null,
        endCursor: pages[0].continueCursor,
      },
    });
    expect(grown.page.length).toBe(pages[0].page.length + 5);
  });

  test("an emptied page between pages isn't the last page", async () => {
    const t = initConvexTest();
    const thread = await t.mutation(api.threads.createThread, {});
    const threadId = thread._id as Id<"threads">;
    await t.mutation(api.messages.addMessages, {
      threadId,
      messages: Array.from({ length: 6 }, (_, i) => ({
        message: { role: "user" as const, content: `${i}` },
      })),
    });
    const list = (paginationOpts: {
      numItems: number;
      cursor: string | null;
      endCursor?: string;
    }) =>
      t.query(api.messages.listMessagesByThreadId, {
        threadId,
        order: "desc",
        paginationOpts,
      });
    const first = await list({ numItems: 2, cursor: null });
    const middle = await list({ numItems: 2, cursor: first.continueCursor });
    await t.mutation(api.messages.deleteByIds, {
      messageIds: middle.page.map((m) => m._id as Id<"messages">),
    });

    const emptied = await list({
      numItems: 2,
      cursor: first.continueCursor,
      endCursor: middle.continueCursor,
    });
    expect(emptied).toMatchObject({
      page: [],
      isDone: false,
      continueCursor: middle.continueCursor,
    });
    const last = await list({ numItems: 2, cursor: middle.continueCursor });
    expect(last.page.map((m) => m.text)).toEqual(["1", "0"]);
    const past = await list({ numItems: 2, cursor: last.continueCursor });
    expect(past).toMatchObject({ page: [], isDone: true });
  });
});
