/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import schema from "./schema.js";
import { modules } from "./setup.test.js";

describe("users", () => {
  test("listUsersWithThreads returns users who have threads", async () => {
    const t = convexTest(schema, modules);

    // Create two users with threads and one without
    await t.mutation(api.threads.createThread, {
      userId: "user1",
      title: "Test thread 1",
    });
    await t.mutation(api.threads.createThread, {
      userId: "user2",
      title: "Test thread 2",
    });
    await t.mutation(api.threads.createThread, {
      userId: "user1", // Same user, different thread
      title: "Test thread 3",
    });

    const result = await t.query(api.users.listUsersWithThreads, {
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result.page).toHaveLength(2);
    expect(result.page).toContain("user1");
    expect(result.page).toContain("user2");
  });

  test("listUsersWithThreads pagination works", async () => {
    const t = convexTest(schema, modules);

    // Create multiple users with threads
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.threads.createThread, {
        userId: `user${i}`,
        title: `Test thread ${i}`,
      });
    }

    const firstPage = await t.query(api.users.listUsersWithThreads, {
      paginationOpts: { cursor: null, numItems: 2 },
    });

    expect(firstPage.page).toHaveLength(2);
    expect(firstPage.isDone).toBe(false);

    const secondPage = await t.query(api.users.listUsersWithThreads, {
      paginationOpts: { cursor: firstPage.continueCursor, numItems: 2 },
    });

    expect(secondPage.page).toHaveLength(2);
    // Should not have duplicate users
    expect(
      firstPage.page.every((user) => !secondPage.page.includes(user)),
    ).toBe(true);
  });

  test("deleteAllForUserId sync deletes all threads and messages for a user", async () => {
    const t = convexTest(schema, modules);

    // Create a user with multiple threads and messages
    const thread1 = await t.mutation(api.threads.createThread, {
      userId: "testUser",
      title: "Thread 1",
    });
    const thread2 = await t.mutation(api.threads.createThread, {
      userId: "testUser",
      title: "Thread 2",
    });

    // Add messages to both threads
    await t.mutation(api.messages.addMessages, {
      threadId: thread1._id as Id<"threads">,
      messages: [
        { message: { role: "user" as const, content: "Hello thread 1" } },
        {
          message: { role: "assistant" as const, content: "Response thread 1" },
        },
      ],
    });

    await t.mutation(api.messages.addMessages, {
      threadId: thread2._id as Id<"threads">,
      messages: [
        { message: { role: "user" as const, content: "Hello thread 2" } },
        {
          message: { role: "assistant" as const, content: "Response thread 2" },
        },
      ],
    });

    // Verify data exists before deletion
    const beforeThreads = await t.query(api.threads.listThreadsByUserId, {
      userId: "testUser",
    });
    expect(beforeThreads.page).toHaveLength(2);

    const beforeMessages1 = await t.query(api.messages.listMessagesByThreadId, {
      threadId: thread1._id as Id<"threads">,
      order: "desc",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    const beforeMessages2 = await t.query(api.messages.listMessagesByThreadId, {
      threadId: thread2._id as Id<"threads">,
      order: "desc",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(beforeMessages1.page).toHaveLength(2);
    expect(beforeMessages2.page).toHaveLength(2);

    // Delete all data for the user
    await t.action(api.users.deleteAllForUserId, { userId: "testUser" });

    // Verify all threads are deleted
    const afterThreads = await t.query(api.threads.listThreadsByUserId, {
      userId: "testUser",
    });
    expect(afterThreads.page).toHaveLength(0);

    // Verify threads are actually deleted from DB
    const thread1After = await t.query(api.threads.getThread, {
      threadId: thread1._id as Id<"threads">,
    });
    const thread2After = await t.query(api.threads.getThread, {
      threadId: thread2._id as Id<"threads">,
    });
    expect(thread1After).toBeNull();
    expect(thread2After).toBeNull();
  });

  test("deleteAllForUserIdAsync deletes data asynchronously", async () => {
    // Enable fake timers for scheduled function testing
    vi.useFakeTimers();

    const t = convexTest(schema, modules);

    // Create a user with a thread and messages
    const thread = await t.mutation(api.threads.createThread, {
      userId: "asyncUser",
      title: "Async Thread",
    });

    await t.mutation(api.messages.addMessages, {
      threadId: thread._id as Id<"threads">,
      messages: [
        { message: { role: "user" as const, content: "Hello async" } },
        { message: { role: "assistant" as const, content: "Response async" } },
      ],
    });

    // Start async deletion
    const result = await t.mutation(api.users.deleteAllForUserIdAsync, {
      userId: "asyncUser",
    });

    // If there's more work to do, advance timers and wait for scheduled functions
    if (!result) {
      // Run all pending timers to trigger scheduled functions
      vi.runAllTimers();

      // Wait for all scheduled functions to complete
      await t.finishInProgressScheduledFunctions();
    }

    // Verify deletion completed
    const afterThreads = await t.query(api.threads.listThreadsByUserId, {
      userId: "asyncUser",
    });
    expect(afterThreads.page).toHaveLength(0);

    // Reset to normal timers
    vi.useRealTimers();
  });

  test("deleteAllForUserIdAsync deletes what the user saves while it runs", async () => {
    vi.useFakeTimers();

    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, { userId: "u" });
    expect(
      await t.mutation(api.users.deleteAllForUserIdAsync, { userId: "u" }),
    ).toBe(false);
    await t
      .mutation(api.messages.addMessages, {
        threadId: thread._id as Id<"threads">,
        userId: "u",
        messages: [{ message: { role: "user", content: "During delete." } }],
      })
      .catch((error) => expect(String(error)).toMatch("not found"));
    const later = await t.mutation(api.threads.createThread, { userId: "u" });
    await t.mutation(api.messages.addMessages, {
      threadId: later._id as Id<"threads">,
      userId: "u",
      messages: [{ message: { role: "user", content: "New thread." } }],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    expect(
      await t.run(async (ctx) => ({
        threads: await ctx.db.query("threads").collect(),
        messages: await ctx.db.query("messages").collect(),
      })),
    ).toEqual({ threads: [], messages: [] });
  });

  test("a deletion scheduled with the earlier resume args still finishes", async () => {
    vi.useFakeTimers();

    const t = convexTest(schema, modules);
    const thread = await t.mutation(api.threads.createThread, { userId: "u" });
    const threadId = thread._id as Id<"threads">;
    await t.mutation(api.messages.addMessages, {
      threadId,
      messages: Array.from({ length: 3 }, (_, i) => ({
        message: { role: "user" as const, content: `Message ${i}` },
      })),
    });
    const cursors = await t.run(async (ctx) => ({
      threadsCursor: (
        await ctx.db
          .query("threads")
          .withIndex("userId", (q) => q.eq("userId", "u"))
          .order("desc")
          .paginate({ numItems: 1, cursor: null })
      ).continueCursor,
      messagesCursor: await ctx.db
        .query("messages")
        .withIndex("threadId_status_tool_order_stepOrder", (q) =>
          q.eq("threadId", threadId),
        )
        .order("desc")
        .paginate({ numItems: 1, cursor: null })
        .then(async ({ page, continueCursor }) => {
          await ctx.db.delete("messages", page[0]._id);
          return continueCursor;
        }),
    }));

    await t.mutation(internal.users._deleteAllForUserIdAsync, {
      userId: "u",
      ...cursors,
      threadInProgress: threadId,
      streamsInProgress: false,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    expect(
      await t.run(async (ctx) => ({
        threads: await ctx.db.query("threads").collect(),
        messages: await ctx.db.query("messages").collect(),
      })),
    ).toEqual({ threads: [], messages: [] });
  });

  test("deleteAllForUserIdAsync with multiple scheduled iterations", async () => {
    // Enable fake timers for scheduled function testing
    vi.useFakeTimers();

    const t = convexTest(schema, modules);

    // Create a user with multiple threads and many messages to force multiple scheduling iterations
    const thread1 = await t.mutation(api.threads.createThread, {
      userId: "multiIterUser",
      title: "Multi Iter Thread 1",
    });
    const thread2 = await t.mutation(api.threads.createThread, {
      userId: "multiIterUser",
      title: "Multi Iter Thread 2",
    });

    // Add many messages to force pagination
    const messages = [];
    for (let i = 0; i < 150; i++) {
      messages.push({
        message: { role: "user" as const, content: `Message ${i}` },
      });
    }
    await t.mutation(api.messages.addMessages, {
      threadId: thread1._id as Id<"threads">,
      messages,
    });
    await t.mutation(api.messages.addMessages, {
      threadId: thread2._id as Id<"threads">,
      messages,
    });

    // Start async deletion
    const result = await t.mutation(api.users.deleteAllForUserIdAsync, {
      userId: "multiIterUser",
    });

    // Should return false since there's a lot of work to do
    expect(result).toBe(false);

    // Use finishAllScheduledFunctions to handle recursive scheduling
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Verify all data is deleted
    const afterThreads = await t.query(api.threads.listThreadsByUserId, {
      userId: "multiIterUser",
    });
    expect(afterThreads.page).toHaveLength(0);

    // Reset to normal timers
    vi.useRealTimers();
  });

  test("getThreadUserId returns correct userId", async () => {
    const t = convexTest(schema, modules);

    const thread = await t.mutation(api.threads.createThread, {
      userId: "testUserId",
      title: "Test Thread",
    });

    const userId = await t.query(internal.users.getThreadUserId, {
      threadId: thread._id as Id<"threads">,
    });

    expect(userId).toBe("testUserId");
  });

  test("getThreadUserId returns null for non-existent thread", async () => {
    const t = convexTest(schema, modules);

    // Create a thread, then delete it to get a valid but non-existent ID
    const thread = await t.mutation(api.threads.createThread, {
      userId: "tempUser",
      title: "Temp Thread",
    });

    // Delete the thread so it no longer exists
    await t.action(api.threads.deleteAllForThreadIdSync, {
      threadId: thread._id as Id<"threads">,
    });

    // Now test with the deleted thread's ID
    const userId = await t.query(internal.users.getThreadUserId, {
      threadId: thread._id as Id<"threads">,
    });

    expect(userId).toBeNull();
  });

  test("deleteAllForUserId handles user with no threads", async () => {
    const t = convexTest(schema, modules);

    // Try to delete for a user that doesn't exist
    await expect(
      t.action(api.users.deleteAllForUserId, { userId: "nonexistentUser" }),
    ).resolves.not.toThrow();

    // Should complete successfully without errors
  });
});
