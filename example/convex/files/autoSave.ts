// See the docs at https://docs.convex.dev/agents/files
import { v } from "convex/values";
import { action } from "../_generated/server";
import { agent } from "../agents/simple";
import { components } from "../_generated/api";
import { createThread } from "@convex-dev/agent";

/**
 * This is a simple example of how to use the automatic file saving.
 * By passing in bytes directly, it will automatically store the file in file
 * storage and pass around the URL. It will also automatically re-use files
 * if you upload the same file multiple times. See [vacuum.ts](./vacuum.ts)
 * for how to clean up files no longer referenced.
 */
export const askAboutImage = action({
  args: {
    prompt: v.string(),
    image: v.bytes(),
    mediaType: v.string(),
  },
  handler: async (ctx, { prompt, image, mediaType }) => {
    const threadId = await createThread(ctx, components.agent);
    const result = await agent.generateText(
      ctx,
      { threadId },
      {
        prompt,
        messages: [
          {
            role: "user",
            content: [
              // You can pass the data in directly. It will automatically store
              // it in file storage and pass around the URL.
              { type: "file", data: image, mediaType },
              { type: "text", text: prompt },
            ],
          },
        ],
      },
    );
    return { threadId, result: result.text };
  },
});

// TODO: show an example of using http action or file storage.
