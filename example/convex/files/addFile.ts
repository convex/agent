// See the docs at https://docs.convex.dev/agents/files
import { Agent, createThread, saveMessage, storeFile } from "@convex-dev/agent";
import { components, internal } from "../_generated/api";
import { action, internalAction, mutation } from "../_generated/server";
import { v } from "convex/values";
import { getFile } from "@convex-dev/agent";
import { getAuthUserId } from "../utils";
import { defaultConfig } from "../agents/config";

// Define an agent similarly to the AI SDK
export const fileAgent = new Agent(components.agent, {
  name: "File Reviewer Agent",
  instructions: "You are an expert in reviewing and analyzing files & images.",
  ...defaultConfig,
});

/**
 * OPTION 2 (Recommended):
 * Do each step separately.
 *
 * This allows the user to upload the file ahead of time,
 * then submit a question with an optimistic update and have the response
 * generated asynchronously.
 */

// Step 1: Upload a file - this could be an httpAction if the file is big.
export const uploadFile = action({
  args: {
    filename: v.string(),
    mimeType: v.string(),
    bytes: v.bytes(),
    sha256: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthorized");
    }
    // Note: we're using storeFile which will store the file in file storage
    // or re-use an existing file with the same hash and track references.
    const {
      file: { fileId, url },
    } = await storeFile(
      ctx,
      components.agent,
      new Blob([args.bytes], { type: args.mimeType }),
      {
        filename: args.filename,
        sha256: args.sha256,
      },
    );
    return { fileId, url };
  },
});

// Step 2: Submit a question about the file
export const submitFileQuestion = mutation({
  args: {
    fileId: v.string(),
    question: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthorized");
    }
    const threadId = await createThread(ctx, components.agent, { userId });
    const { filePart, imagePart } = await getFile(
      ctx,
      components.agent,
      args.fileId,
    );
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId,
      message: {
        role: "user",
        content: [imagePart ?? filePart, { type: "text", text: args.question }],
      },
      // This will track the usage of the file, so we can delete old ones
      metadata: { fileIds: [args.fileId] },
    });
    await ctx.scheduler.runAfter(0, internal.files.addFile.generateResponse, {
      threadId,
      promptMessageId: messageId,
    });
    return { threadId };
  },
});

// Step 3: Generate a response to the question asynchronously
export const generateResponse = internalAction({
  args: { threadId: v.string(), promptMessageId: v.string() },
  handler: async (ctx, { threadId, promptMessageId }) => {
    await fileAgent.generateText(ctx, { threadId }, { promptMessageId });
  },
});
