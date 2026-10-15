import {
  embedMany as embedMany_,
  type EmbeddingModel,
  type ModelMessage,
} from "ai";
import { assert } from "convex-helpers";
import type { MessageDoc } from "../../validators.js";
import {
  validateVectorDimension,
  type VectorDimension,
} from "../../component/vector/tables.js";
import {
  DEFAULT_MESSAGE_RANGE,
  DEFAULT_RECENT_MESSAGES,
  extractText,
  getModelName,
  getProviderName,
  isTool,
  sorted,
} from "../../shared.js";
import type { Message } from "../../validators.js";
import type {
  AgentComponent,
  Config,
  ContextOptions,
  Options,
  QueryCtx,
  MutationCtx,
  ActionCtx,
} from "./types.js";
import { inlineMessagesFiles } from "./files.js";
import { docsToModelMessages, toModelMessage } from "../mapping.js";
import {
  finishApprovals,
  hideApprovals,
  planApprovals,
} from "./prepareApprovalContext.js";

const DEFAULT_VECTOR_SCORE_THRESHOLD = 0.0;
// Bound the rare boundary-extension query; incomplete orders are trimmed below.
const MAX_ORDER_COMPLETION_MESSAGES = 1_000;
// 10k characters should be more than enough for most cases, and stays under
// the 8k token limit for some models.
const MAX_EMBEDDING_TEXT_LENGTH = 10_000;

/**
 * Omit the oldest order when a descending pagination window split it.
 * Expects the messages to be sorted in ascending order.
 */
export function trimIncompleteOldestOrder(docs: MessageDoc[]) {
  const oldest = docs[0];
  if (!oldest || oldest.stepOrder === 0) {
    return docs;
  }
  return docs.filter((doc) => doc.order !== oldest.order);
}

export type GetEmbedding = (text: string) => Promise<
  | {
      embedding: number[];
      /** @deprecated Use embeddingModel instead. */
      textEmbeddingModel: string | EmbeddingModel;
      embeddingModel?: string | EmbeddingModel;
    }
  | {
      embedding: number[];
      /** @deprecated Use embeddingModel instead. */
      textEmbeddingModel?: string | EmbeddingModel;
      embeddingModel: string | EmbeddingModel;
    }
>;

/**
 * Fetch the context messages for a thread.
 * @param ctx Either a query, mutation, or action ctx.
 *   If it is not an action context, you can't do text or
 *   vector search.
 * @param args The associated thread, user, message
 * @returns
 */
export async function fetchContextMessages(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  component: AgentComponent,
  args: {
    userId: string | undefined;
    threadId: string | undefined;
    /**
     * If targetMessageId is not provided, this text will be used
     * for text and vector search
     */
    searchText?: string;
    /**
     * If provided, it will use this message for text/vector search (if enabled)
     * and will only fetch messages up to (and including) this message's "order"
     */
    targetMessageId?: string;
    /**
     * @deprecated use searchText and targetMessageId instead
     */
    messages?: (ModelMessage | Message)[];
    /**
     * @deprecated use targetMessageId instead
     */
    upToAndIncludingMessageId?: string;
    contextOptions: ContextOptions;
    getEmbedding?: GetEmbedding;
  },
): Promise<MessageDoc[]> {
  const { recentMessages, searchMessages } = await fetchRecentAndSearchMessages(
    ctx,
    component,
    args,
  );
  return [...searchMessages, ...recentMessages];
}

export async function fetchRecentAndSearchMessages(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  component: AgentComponent,
  args: {
    userId: string | undefined;
    threadId: string | undefined;
    /**
     * If targetMessageId is not provided, this text will be used
     * for text and vector search
     */
    searchText?: string;
    /**
     * If provided, it will use this message for text/vector search (if enabled)
     * and will only fetch messages up to (and including) this message's "order"
     */
    targetMessageId?: string;
    /**
     * @deprecated use searchText and targetMessageId instead
     */
    messages?: (ModelMessage | Message)[];
    /**
     * @deprecated use targetMessageId instead
     */
    upToAndIncludingMessageId?: string;
    contextOptions: ContextOptions;
    getEmbedding?: GetEmbedding;
  },
): Promise<{ recentMessages: MessageDoc[]; searchMessages: MessageDoc[] }> {
  assert(args.userId || args.threadId, "Specify userId or threadId");
  const opts = args.contextOptions;
  // Fetch the latest messages from the thread
  let included: Set<string> | undefined;
  let recentMessages: MessageDoc[] = [];
  let searchMessages: MessageDoc[] = [];
  const threadId = args.threadId;
  const targetMessageId =
    args.targetMessageId ?? args.upToAndIncludingMessageId;
  if (threadId && opts.recentMessages !== 0) {
    const fetchRecentPage = (numItems: number, cursor: string | null) =>
      ctx.runQuery(component.messages.listMessagesByThreadId, {
        threadId,
        excludeToolMessages: opts.excludeToolMessages,
        paginationOpts: { numItems, cursor },
        upToAndIncludingMessageId: targetMessageId,
        order: "desc",
        statuses: ["success"],
      });
    const firstPage = await fetchRecentPage(
      opts.recentMessages ?? DEFAULT_RECENT_MESSAGES,
      null,
    );
    let page = firstPage.page;
    const oldest = page.at(-1);
    if (
      oldest &&
      oldest.stepOrder > 0 &&
      !firstPage.isDone &&
      firstPage.continueCursor
    ) {
      const completionPage = await fetchRecentPage(
        Math.min(oldest.stepOrder, MAX_ORDER_COMPLETION_MESSAGES),
        firstPage.continueCursor,
      );
      page = [
        ...page,
        ...completionPage.page.filter(
          (message) => message.order === oldest.order,
        ),
      ];
    }
    const retained = trimIncompleteOldestOrder(sorted(page));
    included = new Set(retained.map((m) => m._id));
    recentMessages = filterOutOrphanedToolMessages(retained);
  }
  if (
    (opts.searchOptions?.textSearch || opts.searchOptions?.vectorSearch) &&
    opts.searchOptions?.limit
  ) {
    if (!("runAction" in ctx)) {
      throw new Error("searchUserMessages only works in an action");
    }
    let text = args.searchText;
    let embedding: number[] | undefined;
    let embeddingModel: string | undefined;
    if (!text) {
      if (targetMessageId) {
        const targetMessage = recentMessages.find(
          (m) => m._id === targetMessageId,
        );
        if (targetMessage) {
          text = targetMessage.text;
        } else {
          const targetSearchFields = await ctx.runQuery(
            component.messages.getMessageSearchFields,
            {
              messageId: targetMessageId,
            },
          );
          text = targetSearchFields.text;
          embedding = targetSearchFields.embedding;
          embeddingModel = targetSearchFields.embeddingModel;
        }
        assert(text, "Target message has no text for searching");
      } else if (args.messages?.length) {
        text = extractText(args.messages.at(-1)!);
        assert(text, "Final context message has no text to search");
      }
      assert(text, "No text to search");
    }
    if (opts.searchOptions?.vectorSearch) {
      if (!embedding && args.getEmbedding) {
        const embeddingFields = await args.getEmbedding(text);
        embedding = embeddingFields.embedding;
        const effectiveModel =
          embeddingFields.embeddingModel ?? embeddingFields.textEmbeddingModel;
        embeddingModel = effectiveModel
          ? getModelName(effectiveModel)
          : undefined;
        // TODO: if the text matches the target message, save the embedding
        // for the target message and return the embeddingId on the message.
      }
    }
    const searchResults = await ctx.runAction(
      component.messages.searchMessages,
      {
        searchAllMessagesForUserId: opts?.searchOtherThreads
          ? (args.userId ??
            (args.threadId &&
              (
                await ctx.runQuery(component.threads.getThread, {
                  threadId: args.threadId,
                })
              )?.userId))
          : undefined,
        threadId: args.threadId,
        targetMessageId,
        limit: opts.searchOptions?.limit ?? 10,
        messageRange: {
          ...DEFAULT_MESSAGE_RANGE,
          ...opts.searchOptions?.messageRange,
        },
        text,
        textSearch: opts.searchOptions?.textSearch,
        vectorSearch: opts.searchOptions?.vectorSearch,
        vectorScoreThreshold:
          opts.searchOptions?.vectorScoreThreshold ??
          DEFAULT_VECTOR_SCORE_THRESHOLD,
        embedding,
        embeddingModel,
      },
    );
    // TODO: track what messages we used for context
    searchMessages = filterOutOrphanedToolMessages(
      sorted(searchResults.filter((m) => !included?.has(m._id))),
    );
  }
  // Ensure we don't include tool messages without a corresponding tool call
  return { recentMessages, searchMessages };
}

/**
 * Filter out tool calls without a result and results without a call. As for
 * the AI SDK, an approval decision answers its call.
 * @param docs The messages to filter.
 * @returns The filtered messages.
 */
export function filterOutOrphanedToolMessages(docs: MessageDoc[]) {
  const toolCallIds = new Set<string>();
  const answered = new Set<string>();
  const callIdsByApprovalId = new Map<string, string>();
  const decided: string[] = [];
  for (const doc of docs) {
    if (!Array.isArray(doc.message?.content)) continue;
    for (const part of doc.message.content) {
      if (part.type === "tool-call") toolCallIds.add(part.toolCallId);
      else if (part.type === "tool-result") answered.add(part.toolCallId);
      else if (part.type === "tool-approval-request") {
        callIdsByApprovalId.set(part.approvalId, part.toolCallId);
      } else if (part.type === "tool-approval-response") {
        decided.push(part.approvalId);
      }
    }
  }
  for (const approvalId of decided) {
    const toolCallId = callIdsByApprovalId.get(approvalId);
    if (toolCallId) answered.add(toolCallId);
  }

  const result: MessageDoc[] = [];
  for (const doc of docs) {
    if (
      doc.message?.role === "assistant" &&
      Array.isArray(doc.message.content)
    ) {
      const content = doc.message.content.filter(
        (p) => p.type !== "tool-call" || answered.has(p.toolCallId),
      );
      if (content.length) {
        result.push({
          ...doc,
          message: {
            ...doc.message,
            content,
          },
        });
      }
    } else if (doc.message?.role === "tool") {
      const content = doc.message.content.filter(
        (p) => p.type !== "tool-result" || toolCallIds.has(p.toolCallId),
      );
      if (content.length) {
        result.push({
          ...doc,
          message: {
            ...doc.message,
            content,
          },
        });
      }
    } else {
      result.push(doc);
    }
  }
  return result;
}

/**
 * Embed a list of messages, including calling any usage handler.
 * This will not save the embeddings to the database.
 */
export async function embedMessages(
  ctx: ActionCtx,
  {
    userId,
    threadId,
    ...options
  }: {
    userId: string | undefined;
    threadId: string | undefined;
    agentName?: string;
  } & Pick<
    Config,
    "usageHandler" | "textEmbeddingModel" | "embeddingModel" | "callSettings"
  >,
  messages: (ModelMessage | Message)[],
): Promise<
  | {
      vectors: (number[] | null)[];
      dimension: VectorDimension;
      model: string;
    }
  | undefined
> {
  const textEmbeddingModel =
    options.embeddingModel ?? options.textEmbeddingModel;
  if (!textEmbeddingModel) {
    return undefined;
  }
  let embeddings:
    | {
        vectors: (number[] | null)[];
        dimension: VectorDimension;
        model: string;
      }
    | undefined;
  const messageTexts = messages.map((m) => !isTool(m) && extractText(m));
  // Find the indexes of the messages that have text.
  const textIndexes = messageTexts
    .map((t, i) => (t ? i : undefined))
    .filter((i) => i !== undefined);
  if (textIndexes.length === 0) {
    return undefined;
  }
  const values = messageTexts
    .map((t) => t && t.trim().slice(0, MAX_EMBEDDING_TEXT_LENGTH))
    .filter((t): t is string => !!t);
  // Then embed those messages.
  const textEmbeddings = await embedMany(ctx, {
    ...options,
    userId,
    threadId,
    values,
  });
  // Then assemble the embeddings into a single array with nulls for the messages without text.
  const embeddingsOrNull = Array(messages.length).fill(null);
  textIndexes.forEach((i, j) => {
    embeddingsOrNull[i] = textEmbeddings.embeddings[j];
  });
  if (textEmbeddings.embeddings.length > 0) {
    const dimension = textEmbeddings.embeddings[0].length;
    validateVectorDimension(dimension);
    const model = getModelName(textEmbeddingModel);
    embeddings = { vectors: embeddingsOrNull, dimension, model };
  }
  return embeddings;
}

/**
 * Embeds many strings, calling any usage handler.
 * @param ctx The ctx parameter to an action.
 * @param args Arguments to AI SDK's embedMany, and context for the embedding,
 *   passed to the usage handler.
 * @returns The embeddings for the strings, matching the order of the values.
 */
export async function embedMany(
  ctx: ActionCtx,
  args: {
    userId: string | undefined;
    threadId: string | undefined;
    values: string[];
    abortSignal?: AbortSignal;
    headers?: Record<string, string>;
    agentName?: string;
  } & Pick<
    Config,
    "usageHandler" | "textEmbeddingModel" | "embeddingModel" | "callSettings"
  >,
): Promise<{ embeddings: number[][] }> {
  const {
    userId,
    threadId,
    values,
    abortSignal,
    headers,
    agentName,
    usageHandler,
    textEmbeddingModel,
    embeddingModel,
    callSettings,
  } = args;
  const effectiveEmbeddingModel = embeddingModel ?? textEmbeddingModel;
  assert(
    effectiveEmbeddingModel,
    "an embeddingModel (or textEmbeddingModel) is required to be set for vector search",
  );
  const result = await embedMany_({
    ...callSettings,
    model: effectiveEmbeddingModel,
    values,
    abortSignal,
    headers,
  });
  if (usageHandler && result.usage) {
    await usageHandler(ctx, {
      userId,
      threadId,
      agentName,
      model: getModelName(effectiveEmbeddingModel),
      provider: getProviderName(effectiveEmbeddingModel),
      providerMetadata: undefined,
      usage: {
        inputTokens: result.usage.tokens,
        outputTokens: 0,
        totalTokens: result.usage.tokens,
        // These detail fields are required by LanguageModelUsage type but we don't
        // have the granular data, so we provide objects with undefined values.
        inputTokenDetails: {
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
          noCacheTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    });
  }
  return { embeddings: result.embeddings };
}

/**
 * Embed a list of messages, and save the embeddings to the database.
 * @param ctx The ctx parameter to an action.
 * @param component The agent component, usually components.agent.
 * @param args The context for the embedding, passed to the usage handler.
 * @param messages The messages to embed, in the Agent MessageDoc format.
 */
export async function generateAndSaveEmbeddings(
  ctx: ActionCtx,
  component: AgentComponent,
  args: {
    threadId: string | undefined;
    userId: string | undefined;
    agentName?: string;
    /**
     * @deprecated Use embeddingModel instead.
     */
    textEmbeddingModel?: EmbeddingModel;
    embeddingModel?: EmbeddingModel;
  } & Pick<Config, "usageHandler" | "callSettings">,
  messages: MessageDoc[],
) {
  const effectiveEmbeddingModel =
    args.embeddingModel ?? args.textEmbeddingModel;
  if (!effectiveEmbeddingModel) {
    throw new Error(
      "an embeddingModel (or textEmbeddingModel) is required to generate and save embeddings",
    );
  }
  const toEmbed = messages.filter((m) => !m.embeddingId && m.message);
  if (toEmbed.length === 0) {
    return;
  }
  const embeddings = await embedMessages(
    ctx,
    { ...args, embeddingModel: effectiveEmbeddingModel },
    toEmbed.map((m) => m.message!),
  );
  if (embeddings && embeddings.vectors.some((v) => v !== null)) {
    await ctx.runMutation(component.vector.index.insertBatch, {
      vectorDimension: embeddings.dimension,
      vectors: toEmbed
        .map((m, i) => ({
          messageId: m._id,
          model: embeddings.model,
          table: "messages",
          userId: m.userId,
          threadId: m.threadId,
          vector: embeddings.vectors[i]!,
        }))
        .filter((v) => v.vector !== null),
    });
  }
}

/**
 * Similar to fetchContextMessages, but also combines the input messages,
 * with search context, recent messages, input messages, then prompt messages.
 * If there is a promptMessageId and prompt message(s) provided, it will splice
 * the prompt messages into the history to replace the promptMessageId message,
 * but still be followed by any existing messages that were in response to the
 * promptMessageId message.
 */
export async function fetchContextWithPrompt(
  ctx: ActionCtx,
  component: AgentComponent,
  args: {
    prompt: string | (ModelMessage | Message)[] | undefined;
    messages: (ModelMessage | Message)[] | undefined;
    promptMessageId: string | undefined;
    userId: string | undefined;
    threadId: string | undefined;
    agentName?: string;
  } & Options &
    Config,
): Promise<{
  messages: ModelMessage[];
  order: number | undefined;
  stepOrder: number | undefined;
}> {
  const { threadId, userId, textEmbeddingModel, embeddingModel } = args;
  const effectiveEmbeddingModel = embeddingModel ?? textEmbeddingModel;

  const promptArray = getPromptArray(args.prompt);

  const searchText = promptArray.length
    ? extractText(promptArray.at(-1)!)
    : args.promptMessageId
      ? undefined
      : args.messages?.at(-1)
        ? extractText(args.messages.at(-1)!)
        : undefined;
  // If only a messageId is provided, this will add that message to the end.
  const { recentMessages, searchMessages } = await fetchRecentAndSearchMessages(
    ctx,
    component,
    {
      userId,
      threadId,
      targetMessageId: args.promptMessageId,
      searchText,
      contextOptions: args.contextOptions ?? {},
      getEmbedding: async (text) => {
        assert(
          effectiveEmbeddingModel,
          "An embeddingModel (or textEmbeddingModel) is required to be set on the Agent that you're doing vector search with",
        );
        return {
          embedding: (
            await embedMany(ctx, {
              ...args,
              userId,
              values: [text],
              embeddingModel: effectiveEmbeddingModel,
            })
          ).embeddings[0],
          embeddingModel: effectiveEmbeddingModel,
        };
      },
    },
  );

  const promptMessageIndex = args.promptMessageId
    ? recentMessages.findIndex((m) => m._id === args.promptMessageId)
    : -1;
  const promptMessage =
    promptMessageIndex !== -1 ? recentMessages[promptMessageIndex] : undefined;
  let prePromptDocs = recentMessages;
  const messages = args.messages ?? [];
  let existingResponseDocs: MessageDoc[] = [];
  if (promptMessage) {
    prePromptDocs = recentMessages.slice(0, promptMessageIndex);
    existingResponseDocs = recentMessages.slice(promptMessageIndex + 1);
    if (promptArray.length === 0) {
      // If they didn't override the prompt, use the existing prompt message.
      if (promptMessage.message) {
        promptArray.push(promptMessage.message);
      }
    }
    if (!promptMessage.embeddingId && effectiveEmbeddingModel) {
      // Lazily generate embeddings for the prompt message, if it doesn't have
      // embeddings yet. This can happen if the message was saved in a mutation
      // where the LLM is not available.
      await generateAndSaveEmbeddings(
        ctx,
        component,
        {
          ...args,
          userId,
          embeddingModel: effectiveEmbeddingModel,
        },
        [promptMessage],
      );
    }
  }

  const approvals = planApprovals(
    recentMessages,
    searchMessages,
    args.prompt === undefined
      ? continuedApprovals(promptMessage, recentMessages)
      : [],
  );
  const [search] = hideApprovals(approvals, [
    docsToModelMessages(searchMessages),
  ]);
  const [recent, inputMessages, inputPrompt, existingResponses] = hideApprovals(
    approvals,
    [
      docsToModelMessages(prePromptDocs),
      messages.map(toModelMessage),
      promptArray.map(toModelMessage),
      docsToModelMessages(existingResponseDocs),
    ],
  );

  const allMessages = [
    ...search,
    ...recent,
    ...inputMessages,
    ...inputPrompt,
    ...existingResponses,
  ];
  let processedMessages = finishApprovals(
    approvals,
    args.contextHandler
      ? await args.contextHandler(ctx, {
          allMessages,
          search,
          recent,
          inputMessages,
          inputPrompt,
          existingResponses,
          userId,
          threadId,
        })
      : allMessages,
  );

  // Process messages to inline localhost files (if not, file urls pointing to localhost will be sent to LLM providers)
  if (process.env.CONVEX_CLOUD_URL?.startsWith("http://127.0.0.1")) {
    processedMessages = await inlineMessagesFiles(processedMessages);
  }

  return {
    messages: processedMessages,
    order: promptMessage?.order,
    stepOrder: promptMessage?.stepOrder,
  };
}

// A decision prompt continues every request in the one message on its order
// that it answers.
function continuedApprovals(
  promptMessage: MessageDoc | undefined,
  recentMessages: MessageDoc[],
): string[] {
  if (promptMessage?.message?.role !== "tool") return [];
  const answered = promptMessage.message.content.flatMap((part) =>
    part.type === "tool-approval-response" ? [part.approvalId] : [],
  );
  if (answered.length === 0) return [];
  const requests = recentMessages
    .filter((doc) => doc.order === promptMessage.order)
    .map((doc) =>
      doc.message?.role === "assistant" && Array.isArray(doc.message.content)
        ? doc.message.content.flatMap((part) =>
            part.type === "tool-approval-request" ? [part.approvalId] : [],
          )
        : [],
    )
    .filter((ids) => ids.some((id) => answered.includes(id)));
  if (
    requests.length !== 1 ||
    answered.some((id) => !requests[0].includes(id))
  ) {
    throw new Error(
      "Approval continuation requires one complete request message",
    );
  }
  return requests[0];
}

export function getPromptArray(
  prompt: string | (ModelMessage | Message)[] | undefined,
): (ModelMessage | Message)[] {
  return !prompt
    ? []
    : Array.isArray(prompt)
      ? prompt
      : [{ role: "user", content: prompt }];
}
