import type { PaginationOptions, PaginationResult } from "convex/server";
import type { MessageDoc } from "../validators.js";
import { validateVectorDimension } from "../component/vector/tables.js";
import {
  vMessageWithMetadata,
  type Message,
  type MessageEmbeddings,
  type MessageEmbeddingsWithDimension,
  type MessageStatus,
  type MessageWithMetadata,
} from "../validators.js";
import type {
  AgentComponent,
  MutationCtx,
  QueryCtx,
  ActionCtx,
} from "./types.js";
import { parse } from "convex-helpers/validators";
import { runMutation, runQuery } from "./run.js";

/**
 * List messages from a thread.
 * @param ctx A ctx object from a query, mutation, or action.
 * @param component The agent component, usually `components.agent`.
 * @param args.threadId The thread to list messages from.
 * @param args.paginationOpts Pagination options (e.g. via usePaginatedQuery).
 * @param args.excludeToolMessages Whether to exclude tool messages.
 *   False by default.
 * @param args.statuses What statuses to include. All by default.
 * @returns The MessageDoc's in a format compatible with usePaginatedQuery.
 */
export async function listMessages(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  component: AgentComponent,
  {
    threadId,
    paginationOpts,
    excludeToolMessages,
    statuses,
  }: {
    threadId: string;
    paginationOpts: PaginationOptions;
    excludeToolMessages?: boolean;
    statuses?: MessageStatus[];
  },
): Promise<PaginationResult<MessageDoc>> {
  if (paginationOpts.numItems === 0) {
    return {
      page: [],
      isDone: true,
      continueCursor: paginationOpts.cursor ?? "",
    };
  }
  return runQuery(ctx, component.messages.listMessagesByThreadId, {
    order: "desc",
    threadId,
    paginationOpts,
    excludeToolMessages,
    statuses,
  });
}

export type MessageOrder = number | "next";

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
  messages: Message[];
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
  let embeddings: MessageEmbeddingsWithDimension | undefined;
  if (args.embeddings) {
    const dimension = args.embeddings.vectors.find((v) => v !== null)?.length;
    if (dimension) {
      validateVectorDimension(dimension);
      embeddings = {
        model: args.embeddings.model,
        dimension,
        vectors: args.embeddings.vectors,
      };
    }
  }
  const result = await runMutation(ctx, component.messages.addMessages, {
    threadId: args.threadId,
    userId: args.userId ?? undefined,
    agentName: args.agentName,
    promptMessageId: args.promptMessageId,
    order: args.order,
    pendingMessageId: args.pendingMessageId,
    embeddings,
    messages: args.messages.map((message, i) =>
      parse(vMessageWithMetadata, {
        ...args.metadata?.[i],
        message,
      }),
    ),
    failPendingSteps: args.failPendingSteps ?? false,
    onSaveMessages: args.onSaveMessagesHandle,
  });
  return { messages: result.messages };
}
