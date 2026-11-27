import { type ModelMessage } from "ai";
import type { MessageDoc } from "../../validators.js";
import { embedMessages, getPromptArray } from "./search.js";
import type {
  ActionCtx,
  AgentComponent,
  Config,
  MutationCtx,
} from "./types.js";
import { saveAgentMessages } from "./messages.js";
import type { Message } from "../../validators.js";
import { assert } from "convex-helpers";
import type { VectorDimension } from "../../component/vector/tables.js";

export async function saveInputMessages(
  ctx: MutationCtx | ActionCtx,
  component: AgentComponent,
  {
    threadId,
    userId,
    prompt,
    messages,
    ...args
  }: {
    prompt: string | (ModelMessage | Message)[] | undefined;
    messages: (ModelMessage | Message)[] | undefined;
    promptMessageId: string | undefined;
    userId: string | undefined;
    threadId: string;
    agentName?: string;
    onSaveMessagesHandle?: string;
    storageOptions?: {
      saveMessages?: "all" | "promptAndOutput";
    };
    /** Starts the generation's stream with its pending message. */
    createStream?: Parameters<typeof saveAgentMessages>[2]["createStream"];
  } & Pick<
    Config,
    "usageHandler" | "textEmbeddingModel" | "embeddingModel" | "callSettings"
  >,
): Promise<{
  promptMessageId: string | undefined;
  pendingMessage: MessageDoc;
  savedMessages: MessageDoc[];
  streamId: string | undefined;
  turn: { promptMessageId: string; jobId: string } | undefined;
}> {
  const shouldSave = args.storageOptions?.saveMessages ?? "promptAndOutput";
  // If only a promptMessageId is provided, this will be empty.
  const promptArray = getPromptArray(prompt);

  const toSave: (ModelMessage | Message)[] = [];
  if (args.promptMessageId) {
    // We don't save any inputs if a promptMessageId is provided.
    // It's unclear where they'd want to save the new messages.
  } else if (shouldSave === "all") {
    if (messages) toSave.push(...messages);
    toSave.push(...promptArray);
  } else {
    if (promptArray.length) {
      // We treat the whole promptArray as the prompt message to save.
      toSave.push(...promptArray);
    } else if (messages) {
      // Otherwise, treat the last message as the prompt message to save.
      toSave.push(...messages.slice(-1));
    }
  }
  let embeddings:
    | {
        vectors: (number[] | null)[];
        dimension: VectorDimension;
        model: string;
      }
    | undefined;
  if ((args.embeddingModel ?? args.textEmbeddingModel) && toSave.length) {
    assert(
      "runAction" in ctx && "storage" in ctx,
      "You must be in an action context to generate embeddings",
    );
    embeddings = await embedMessages(
      ctx,
      { ...args, userId: userId ?? undefined, threadId },
      toSave,
    );
    if (embeddings) {
      // for the pending message
      embeddings.vectors.push(null);
    }
  }
  const saved = await saveAgentMessages(ctx, component, {
    threadId,
    userId,
    messages: [...toSave, { role: "assistant", content: [] }],
    metadata: [
      ...Array.from({ length: toSave.length }, () => ({})),
      { status: "pending" },
    ],
    failPendingSteps: !!args.promptMessageId,
    promptMessageId: args.promptMessageId,
    embeddings,
    onSaveMessages: args.onSaveMessagesHandle,
    createStream: args.createStream,
  });
  return {
    streamId: saved.streamId,
    turn: saved.turn,
    promptMessageId: toSave.length
      ? saved.messages.at(-2)!._id
      : args.promptMessageId,
    pendingMessage: saved.messages.at(-1)!,
    savedMessages: saved.messages.slice(0, -1),
  };
}
