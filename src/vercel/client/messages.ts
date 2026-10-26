import type { ModelMessage } from "ai";
import type { PaginationOptions, PaginationResult } from "convex/server";
import type { MessageDoc } from "../../validators.js";
import {
  type Message,
  type MessageEmbeddings,
  type MessageWithMetadata,
} from "../../validators.js";
import { serializeMessage } from "../mapping.js";
import { toUIMessages, type UIMessage } from "../UIMessages.js";
import {
  listMessages,
  saveMessages as saveCanonicalMessages,
  type MessageOrder,
} from "../../client/messages.js";
import type {
  AgentComponent,
  MutationCtx,
  QueryCtx,
  ActionCtx,
} from "./types.js";

export { listMessages } from "../../client/messages.js";

export async function listUIMessages(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  component: AgentComponent,
  args: {
    threadId: string;
    paginationOpts: PaginationOptions;
  },
): Promise<PaginationResult<UIMessage>> {
  const result = await listMessages(ctx, component, args);
  return { ...result, page: toUIMessages(result.page) };
}

export type SaveMessagesArgs = {
  threadId: string;
  userId?: string | null;
  /**
   * Save the first message at this order. Pass `"next"` to allocate a new
   * order after the current latest message. If the numeric order already
   * contains messages, the message is appended at the next stepOrder.
   * Numeric orders must be non-negative safe integers less than
   * Number.MAX_SAFE_INTEGER.
   * Cannot be combined with promptMessageId or pendingMessageId.
   */
  order?: MessageOrder;
  /**
   * The message that these messages are in response to. They will be
   * the same "order" as this message, at increasing stepOrder(s).
   */
  promptMessageId?: string;
  /**
   * The messages to save.
   */
  messages: (ModelMessage | Message)[];
  /**
   * Metadata to save with the messages. Each element corresponds to the
   * message at the same index.
   */
  metadata?: Omit<MessageWithMetadata, "message">[];
  /**
   * If true, it will fail any pending steps.
   * Defaults to false.
   */
  failPendingSteps?: boolean;
  /**
   * The embeddings to save with the messages.
   */
  embeddings?: MessageEmbeddings;
  /**
   * A pending message ID to replace when adding messages.
   */
  pendingMessageId?: string;
  /** A function handle from `createFunctionHandle(config.onSaveMessages)`. */
  onSaveMessagesHandle?: string;
};

/**
 * Explicitly save messages associated with the thread (& user if provided)
 */
export async function saveMessages(
  ctx: MutationCtx | ActionCtx,
  component: AgentComponent,
  args: SaveMessagesArgs & {
    /**
     * The agent name to associate with the messages.
     */
    agentName?: string;
  },
): Promise<{ messages: MessageDoc[] }> {
  const serialized = await Promise.all(
    args.messages.map((message) => serializeMessage(ctx, component, message)),
  );
  return saveCanonicalMessages(ctx, component, {
    threadId: args.threadId,
    userId: args.userId ?? undefined,
    agentName: args.agentName,
    promptMessageId: args.promptMessageId,
    order: args.order,
    pendingMessageId: args.pendingMessageId,
    embeddings: args.embeddings,
    messages: serialized.map(({ message }) => message),
    metadata: serialized.map(({ fileIds }, i) => {
      const base = args.metadata?.[i];
      const allFileIds = [...(base?.fileIds ?? [])];
      if (fileIds) allFileIds.push(...fileIds);
      return {
        ...base,
        ...(allFileIds.length > 0 ? { fileIds: allFileIds } : {}),
      };
    }),
    failPendingSteps: args.failPendingSteps ?? false,
    onSaveMessagesHandle: args.onSaveMessagesHandle,
  });
}

export type SaveMessageArgs = {
  threadId: string;
  userId?: string | null;
  /**
   * Save the message at this order. Pass `"next"` to allocate a new order
   * after the current latest message. If the numeric order already contains
   * messages, the message is appended at the next stepOrder. Numeric orders
   * must be non-negative safe integers less than Number.MAX_SAFE_INTEGER.
   * Cannot be combined with promptMessageId or pendingMessageId.
   */
  order?: MessageOrder;
  /**
   * The message that these messages are in response to. They will be
   * the same "order" as this message, at increasing stepOrder(s).
   */
  promptMessageId?: string;
  /**
   * Metadata to save with the messages. Each element corresponds to the
   * message at the same index.
   */
  metadata?: Omit<MessageWithMetadata, "message">;
  /**
   * The embedding to save with the message.
   */
  embedding?: { vector: number[]; model: string };
  /**
   * A pending message ID to replace with this message.
   */
  pendingMessageId?: string;
} & (
  | {
      prompt?: undefined;
      /**
       * The message to save.
       */
      message: ModelMessage | Message;
    }
  | {
      /*
       * The prompt to save with the message.
       */
      prompt: string;
      message?: undefined;
    }
);

/**
 * Save a message to the thread.
 * @param ctx A ctx object from a mutation or action.
 * @param args The message and what to associate it with (user / thread)
 * You can pass extra metadata alongside the message, e.g. associated fileIds.
 * @returns The messageId of the saved message.
 */
export async function saveMessage(
  ctx: MutationCtx | ActionCtx,
  component: AgentComponent,
  args: SaveMessageArgs & {
    /**
     * The agent name to associate with the message.
     */
    agentName?: string;
  },
) {
  let embeddings: { vectors: number[][]; model: string } | undefined;
  if (args.embedding && args.embedding.vector) {
    embeddings = {
      model: args.embedding.model,
      vectors: [args.embedding.vector],
    };
  }
  const { messages } = await saveMessages(ctx, component, {
    threadId: args.threadId,
    userId: args.userId ?? undefined,
    agentName: args.agentName,
    promptMessageId: args.promptMessageId,
    order: args.order,
    pendingMessageId: args.pendingMessageId,
    messages:
      args.prompt !== undefined
        ? [{ role: "user", content: args.prompt }]
        : [args.message],
    metadata: args.metadata ? [args.metadata] : undefined,
    embeddings,
  });
  const message = messages.at(-1)!;
  return { messageId: message._id, message };
}
