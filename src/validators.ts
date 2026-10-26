import type { Infer, Validator, Value } from "convex/values";
import { v } from "convex/values";
import { vVectorDimension } from "./component/vector/tables.js";

// const deprecated = v.optional(v.any()) as unknown as VNull<unknown, "optional">;

export const vProviderOptions = v.record(
  v.string(),
  v.record(v.string(), v.any()),
);
const providerOptions = v.optional(vProviderOptions);
export type ProviderOptions = Infer<typeof providerOptions>;

export const vProviderMetadata = vProviderOptions;
const providerMetadata = providerOptions;
export type ProviderMetadata = Infer<typeof providerMetadata>;

export const vProviderReference = v.object({
  type: v.literal("reference"),
  reference: v.record(v.string(), v.string()),
});

export const vThreadStatus = v.union(
  v.literal("active"),
  v.literal("archived"), // unused
);
export const vMessageStatus = v.union(
  v.literal("pending"),
  v.literal("success"),
  v.literal("failed"),
);
export type MessageStatus = Infer<typeof vMessageStatus>;

export const vRole = v.union(
  v.literal("system"),
  v.literal("user"),
  v.literal("assistant"),
  v.literal("tool"),
);

export const vTextPart = v.object({
  type: v.literal("text"),
  text: v.string(),
  providerOptions,
  providerMetadata,
});

export const vImagePart = v.object({
  type: v.literal("image"),
  image: v.union(v.string(), v.bytes(), vProviderReference),
  mediaType: v.optional(v.string()),
  /** @deprecated Use `mediaType` instead. */
  mimeType: v.optional(v.string()),
  providerOptions,
});

export const vFilePart = v.object({
  type: v.literal("file"),
  data: v.union(v.string(), v.bytes(), vProviderReference),
  filename: v.optional(v.string()),
  mediaType: v.optional(v.string()),
  /** @deprecated Use `mediaType` instead. */
  mimeType: v.optional(v.string()),
  providerOptions,
  providerMetadata,
});

export const vUserContent = v.union(
  v.string(),
  v.array(v.union(vTextPart, vImagePart, vFilePart)),
);

export const vReasoningPart = v.object({
  type: v.literal("reasoning"),
  text: v.string(),
  signature: v.optional(v.string()),
  providerOptions,
  providerMetadata,
});

export const vReasoningFilePart = v.object({
  type: v.literal("reasoning-file"),
  url: v.optional(v.string()),
  data: v.optional(v.union(v.string(), v.bytes())),
  mediaType: v.string(),
  providerOptions,
  providerMetadata,
});

export const vCustomContentPart = v.object({
  type: v.literal("custom"),
  kind: v.string(),
  providerOptions,
  providerMetadata,
});
export const vRedactedReasoningPart = v.object({
  type: v.literal("redacted-reasoning"),
  data: v.string(),
  providerOptions,
  providerMetadata,
});

export const vReasoningDetails = v.array(
  v.union(
    vReasoningPart,
    v.object({
      type: v.literal("text"),
      text: v.string(),
      signature: v.optional(v.string()),
    }),
    v.object({ type: v.literal("redacted"), data: v.string() }),
  ),
);

export const vSourcePart = v.union(
  v.object({
    type: v.literal("source"),
    sourceType: v.literal("url"),
    id: v.string(),
    url: v.string(),
    title: v.optional(v.string()),
    providerOptions,
    providerMetadata,
  }),
  v.object({
    type: v.literal("source"),
    sourceType: v.literal("document"),
    id: v.string(),
    mediaType: v.string(),
    title: v.string(),
    filename: v.optional(v.string()),
    providerOptions,
    providerMetadata,
  }),
);
export type SourcePart = Infer<typeof vSourcePart>;

// Union type to support both old (args) and new (input) formats
// Both include input for type hint support
export const vToolCallPart = v.union(
  // New format: input is primary, args is optional for backwards compat
  v.object({
    type: v.literal("tool-call"),
    toolCallId: v.string(),
    toolName: v.string(),
    input: v.any(),
    /** @deprecated Use `input` instead. */
    args: v.optional(v.any()),
    providerExecuted: v.optional(v.boolean()),
    title: v.optional(v.string()),
    toolMetadata: v.optional(v.record(v.string(), v.any())),
    providerOptions,
    providerMetadata,
  }),
  // Legacy format: args is present, input is optional
  v.object({
    type: v.literal("tool-call"),
    toolCallId: v.string(),
    toolName: v.string(),
    /** @deprecated Use `input` instead. */
    args: v.any(),
    input: v.optional(v.any()),
    providerExecuted: v.optional(v.boolean()),
    title: v.optional(v.string()),
    toolMetadata: v.optional(v.record(v.string(), v.any())),
    providerOptions,
    providerMetadata,
  }),
);

const vToolResultContent = v.array(
  v.union(
    v.object({ type: v.literal("text"), text: v.string() }),
    v.object({
      type: v.literal("image"),
      data: v.string(),
      mimeType: v.optional(v.string()),
    }),
  ),
);

export const vToolResultOutput = v.union(
  v.object({ type: v.literal("text"), value: v.string(), providerOptions }),
  v.object({ type: v.literal("json"), value: v.any(), providerOptions }),
  v.object({
    type: v.literal("error-text"),
    value: v.string(),
    providerOptions,
  }),
  v.object({ type: v.literal("error-json"), value: v.any(), providerOptions }),
  v.object({
    type: v.literal("execution-denied"),
    reason: v.optional(v.string()),
    providerOptions,
  }),
  v.object({
    type: v.literal("content"),
    value: v.array(
      v.union(
        v.object({
          type: v.literal("text"),
          text: v.string(),
          providerOptions,
        }),
        v.object({
          type: v.literal("file"),
          data: v.union(
            v.object({ type: v.literal("url"), url: v.string() }),
            vProviderReference,
            v.object({
              type: v.literal("data"),
              data: v.union(v.string(), v.bytes()),
            }),
            v.object({ type: v.literal("text"), text: v.string() }),
          ),
          mediaType: v.string(),
          filename: v.optional(v.string()),
          providerOptions,
        }),
        /** @deprecated Use `image-data` or `file-data` instead. */
        v.object({
          type: v.literal("media"),
          data: v.string(),
          mediaType: v.string(),
        }),
        v.object({
          type: v.literal("file-data"),
          /** Base-64 encoded */
          data: v.string(),
          /**
           * IANA media type.
           * @see https://www.iana.org/assignments/media-types/media-types.xhtml
           */
          mediaType: v.string(),
          filename: v.optional(v.string()),
          providerOptions,
        }),
        v.object({
          type: v.literal("file-url"),
          url: v.string(),
          mediaType: v.optional(v.string()),
          providerOptions,
        }),
        v.object({
          type: v.literal("file-id"),
          /**
           * ID of the file.
           *
           * If you use multiple providers, you need to
           * specify the provider specific ids using
           * the Record option. The key is the provider
           * name, e.g. 'openai' or 'anthropic'.
           */
          fileId: v.union(v.string(), v.record(v.string(), v.string())),
          providerOptions,
        }),
        v.object({
          type: v.literal("file-reference"),
          providerReference: v.record(v.string(), v.string()),
          providerOptions,
        }),
        v.object({
          type: v.literal("image-data"),
          data: v.string(),
          /**
           * IANA media type.
           * @see https://www.iana.org/assignments/media-types/media-types.xhtml
           */
          mediaType: v.string(),
          providerOptions,
        }),
        v.object({
          type: v.literal("image-file-reference"),
          providerReference: v.record(v.string(), v.string()),
          providerOptions,
        }),
        v.object({
          type: v.literal("image-url"),
          url: v.string(),
          providerOptions,
        }),
        v.object({
          /**
           * Images that are referenced using a provider file id.
           */
          type: v.literal("image-file-id"),
          /**
           * Image that is referenced using a provider file id.
           *
           * If you use multiple providers, you need to
           * specify the provider specific ids using
           * the Record option. The key is the provider
           * name, e.g. 'openai' or 'anthropic'.
           */
          fileId: v.union(v.string(), v.record(v.string(), v.string())),
          providerOptions,
        }),
        v.object({
          /**
           * Custom content part. This can be used to implement
           * provider-specific content parts.
           */
          type: v.literal("custom"),
          providerOptions,
        }),
      ),
    ),
  }),
);

/**
 * Tool approval request prompt part.
 */
export const vToolApprovalRequest = v.object({
  type: v.literal("tool-approval-request"),
  /**
   * ID of the tool approval.
   */
  approvalId: v.string(),
  /**
   * ID of the tool call that the approval request is for.
   */
  toolCallId: v.string(),
  isAutomatic: v.optional(v.boolean()),
  signature: v.optional(v.string()),
  /** @todo Should we continue to include? */
  providerMetadata,
  /** @todo Should we continue to include? */
  providerOptions,
});

/**
 * Tool approval response prompt part.
 */
export const vToolApprovalResponse = v.object({
  type: v.literal("tool-approval-response"),
  /**
   * ID of the tool approval.
   */
  approvalId: v.string(),
  /**
   * Flag indicating whether the approval was granted or denied.
   */
  approved: v.boolean(),
  /**
   * Optional reason for the approval or denial.
   */
  reason: v.optional(v.string()),
  /**
   * Flag indicating whether the tool call is provider-executed.
   * Only provider-executed tool approval responses should be sent to the model.
   */
  providerExecuted: v.optional(v.boolean()),
  /** @todo Should we continue to include? */
  providerMetadata,
  /** @todo Should we continue to include? */
  providerOptions,
});

export const vToolResultPart = v.object({
  type: v.literal("tool-result"),
  toolCallId: v.string(),
  toolName: v.string(),
  output: v.optional(vToolResultOutput),

  providerOptions,
  providerMetadata,
  providerExecuted: v.optional(v.boolean()),

  // Deprecated in ai v5
  result: v.optional(v.any()), // either this or output will be present
  isError: v.optional(v.boolean()),
  // This is only here b/c steps include it in toolResults
  // Normal ModelMessage doesn't have this
  args: v.optional(v.any()),
  experimental_content: v.optional(vToolResultContent),
});
export const vToolContent = v.array(
  v.union(vToolResultPart, vToolApprovalResponse),
);

export const vAssistantContent = v.union(
  v.string(),
  v.array(
    v.union(
      vTextPart,
      vFilePart,
      vReasoningPart,
      vReasoningFilePart,
      vCustomContentPart,
      vRedactedReasoningPart,
      vToolCallPart,
      vToolResultPart,
      vSourcePart,
      vToolApprovalRequest,
    ),
  ),
);

export const vContent = v.union(vUserContent, vAssistantContent, vToolContent);
export type Content = Infer<typeof vContent>;

export const vUserMessage = v.object({
  role: v.literal("user"),
  content: vUserContent,
  providerOptions,
});

export const vAssistantMessage = v.object({
  role: v.literal("assistant"),
  content: vAssistantContent,
  providerOptions,
});

export const vToolMessage = v.object({
  role: v.literal("tool"),
  content: vToolContent,
  providerOptions,
});

export const vSystemMessage = v.object({
  role: v.literal("system"),
  content: v.string(),
  providerOptions,
});

export const vMessage = v.union(
  vUserMessage,
  vAssistantMessage,
  vToolMessage,
  vSystemMessage,
);
export type Message = Infer<typeof vMessage>;

export type MessageContentParts =
  | Infer<typeof vTextPart>
  | Infer<typeof vImagePart>
  | Infer<typeof vFilePart>
  | Infer<typeof vReasoningPart>
  | Infer<typeof vReasoningFilePart>
  | Infer<typeof vCustomContentPart>
  | Infer<typeof vRedactedReasoningPart>
  | Infer<typeof vToolCallPart>
  | Infer<typeof vToolResultPart>
  | Infer<typeof vSourcePart>
  | Infer<typeof vToolApprovalRequest>
  | Infer<typeof vToolApprovalResponse>;

export const vSource = v.union(
  v.object({
    type: v.optional(v.literal("source")),
    sourceType: v.literal("url"),
    id: v.string(),
    url: v.string(),
    title: v.optional(v.string()),
    providerOptions,
    providerMetadata,
  }),
  v.object({
    type: v.literal("source"),
    sourceType: v.literal("document"),
    id: v.string(),
    mediaType: v.string(),
    title: v.string(),
    filename: v.optional(v.string()),
    providerOptions,
    providerMetadata,
  }),
);

export const vRequest = v.object({
  body: v.optional(v.any()),
  // These are not usually present
  headers: v.optional(v.record(v.string(), v.string())),
  method: v.optional(v.string()),
  url: v.optional(v.string()),
});

export const vFinishReason = v.union(
  v.literal("stop"),
  v.literal("length"),
  v.literal("content-filter"),
  v.literal("tool-calls"),
  v.literal("error"),
  v.literal("other"),
  v.literal("unknown"),
);

export const vUsage = v.object({
  promptTokens: v.optional(v.number()),
  completionTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
  reasoningTokens: v.optional(v.number()),
  cachedInputTokens: v.optional(v.number()),
  nonCachedInputTokens: v.optional(v.number()),
  cacheWriteInputTokens: v.optional(v.number()),
  textOutputTokens: v.optional(v.number()),
  raw: v.optional(v.record(v.string(), v.any())),
});
export type Usage = Infer<typeof vUsage>;

export const vLanguageModelCallWarning = v.union(
  v.object({
    type: v.literal("unsupported"),
    feature: v.string(),
    details: v.optional(v.string()),
  }),
  v.object({
    type: v.literal("compatibility"),
    feature: v.string(),
    details: v.optional(v.string()),
  }),
  v.object({
    type: v.literal("deprecated"),
    setting: v.string(),
    message: v.string(),
  }),
  v.object({
    type: v.literal("unsupported-setting"),
    setting: v.string(),
    details: v.optional(v.string()),
  }),
  v.object({
    type: v.literal("unsupported-tool"),
    tool: v.any(),
    details: v.optional(v.string()),
  }),
  v.object({ type: v.literal("other"), message: v.string() }),
);

export const vMessageWithMetadataInternal = v.object({
  message: vMessage,
  text: v.optional(v.string()),
  fileIds: v.optional(v.array(v.id("files"))),
  status: v.optional(vMessageStatus),
  // metadata
  finishReason: v.optional(vFinishReason),
  model: v.optional(v.string()),
  provider: v.optional(v.string()),
  providerMetadata,
  sources: v.optional(v.array(vSource)),
  reasoning: v.optional(v.string()),
  reasoningDetails: v.optional(vReasoningDetails),
  usage: v.optional(vUsage),
  warnings: v.optional(v.array(vLanguageModelCallWarning)),
  error: v.optional(v.string()),
});
export type MessageWithMetadataInternal = Infer<
  typeof vMessageWithMetadataInternal
>;
export const vMessageWithMetadata = v.object({
  ...vMessageWithMetadataInternal.fields,
  fileIds: v.optional(v.array(v.string())),
});
export type MessageWithMetadata = Infer<typeof vMessageWithMetadata>;

export const vMessageEmbeddingsWithDimension = v.object({
  model: v.string(),
  dimension: vVectorDimension,
  vectors: v.array(v.union(v.array(v.number()), v.null())),
});
export type MessageEmbeddingsWithDimension = Infer<
  typeof vMessageEmbeddingsWithDimension
>;

export const vMessageEmbeddings = v.object({
  model: v.string(),
  vectors: v.array(v.union(v.array(v.number()), v.null())),
});
export type MessageEmbeddings = Infer<typeof vMessageEmbeddings>;

export const vContextOptionsSearchOptions = v.object({
  limit: v.number(),
  textSearch: v.optional(v.boolean()),
  vectorSearch: v.optional(v.boolean()),
  vectorScoreThreshold: v.optional(v.number()),
  messageRange: v.optional(v.object({ before: v.number(), after: v.number() })),
});

export const vContextOptions = v.object({
  excludeToolMessages: v.optional(v.boolean()),
  recentMessages: v.optional(v.number()),
  searchOptions: v.optional(vContextOptionsSearchOptions),
  searchOtherThreads: v.optional(v.boolean()),
});

export const vStorageOptions = v.object({
  saveMessages: v.optional(
    v.union(v.literal("all"), v.literal("none"), v.literal("promptAndOutput")),
  ),
});

// Generated Convex actions keep the established `system` wire field. The
// Vercel adapter translates it to AI SDK 7's `instructions` before invoking
// the model, so action payloads never carry both spellings.
const vActionPromptFields = {
  system: v.optional(
    v.union(v.string(), vSystemMessage, v.array(vSystemMessage)),
  ),
  prompt: v.optional(v.string()),
  messages: v.optional(v.array(vMessage)),
  promptMessageId: v.optional(v.string()),
};

export const vCallSettings = v.object({
  maxOutputTokens: v.optional(v.number()),
  temperature: v.optional(v.number()),
  topP: v.optional(v.number()),
  topK: v.optional(v.number()),
  presencePenalty: v.optional(v.number()),
  frequencyPenalty: v.optional(v.number()),
  stopSequences: v.optional(v.array(v.string())),
  seed: v.optional(v.number()),
  maxRetries: v.optional(v.number()),
  headers: v.optional(v.record(v.string(), v.string())),
});
export type CallSettings = Infer<typeof vCallSettings>;

const vCommonArgs = {
  userId: v.optional(v.string()),
  threadId: v.optional(v.string()),
  contextOptions: v.optional(vContextOptions),
  storageOptions: v.optional(vStorageOptions),
  providerOptions,
  callSettings: v.optional(vCallSettings),
  allowSystemInMessages: v.optional(v.boolean()),
  ...vActionPromptFields,
};

export const vTextArgs = v.object({
  ...vCommonArgs,
  stream: v.optional(v.boolean()),
  toolChoice: v.optional(
    v.union(
      v.literal("auto"),
      v.literal("none"),
      v.literal("required"),
      v.object({ type: v.literal("tool"), toolName: v.string() }),
    ),
  ),
  maxSteps: v.optional(v.number()),
  experimental_continueSteps: v.optional(v.boolean()),
});
export type TextArgs = Infer<typeof vTextArgs>;

export const vSafeObjectArgs = v.object(vCommonArgs);
export type SafeObjectArgs = Infer<typeof vSafeObjectArgs>;

export const vEmbeddingsWithMetadata = v.object({
  vectors: v.array(v.union(v.array(v.number()), v.null())),
  dimension: vVectorDimension,
  model: v.string(),
});
export type EmbeddingsWithMetadata = Infer<typeof vEmbeddingsWithMetadata>;

export function vPaginationResult<
  T extends Validator<Value, "required", string>,
>(itemValidator: T) {
  return v.object({
    page: v.array(itemValidator),
    continueCursor: v.string(),
    isDone: v.boolean(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(
        v.literal("SplitRecommended"),
        v.literal("SplitRequired"),
        v.null(),
      ),
    ),
  });
}

export const vStreamCursor = v.object({
  streamId: v.string(),
  cursor: v.number(),
});
export type StreamCursor = Infer<typeof vStreamCursor>;

export const vStreamArgs = v.optional(
  v.union(
    v.object({ kind: v.literal("list"), startOrder: v.optional(v.number()) }),
    v.object({ kind: v.literal("deltas"), cursors: v.array(vStreamCursor) }),
  ),
);
export type StreamArgs = Infer<typeof vStreamArgs>;

export const vStreamMessage = v.object({
  streamId: v.string(),
  status: v.union(
    v.literal("streaming"),
    v.literal("finished"),
    v.literal("aborted"),
  ),
  format: v.optional(
    v.union(v.literal("UIMessageChunk"), v.literal("TextStreamPart")),
  ),
  order: v.number(),
  stepOrder: v.number(),
  // metadata
  userId: v.optional(v.string()),
  agentName: v.optional(v.string()),
  model: v.optional(v.string()),
  provider: v.optional(v.string()),
  providerOptions, // Sent to model
});
export type StreamMessage = Infer<typeof vStreamMessage>;

export const vStreamDelta = v.object({
  streamId: v.string(),
  start: v.number(), // inclusive
  end: v.number(), // exclusive
  parts: v.array(v.any()),
});
export type StreamDelta = Infer<typeof vStreamDelta>;

export const vMessageDoc = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  userId: v.optional(v.string()), // useful for searching across threads
  threadId: v.string(),
  order: v.number(),
  stepOrder: v.number(),
  embeddingId: v.optional(v.string()),
  fileIds: v.optional(v.array(v.string())),
  error: v.optional(v.string()),
  status: vMessageStatus,

  // Context on how it was generated
  agentName: v.optional(v.string()),
  model: v.optional(v.string()),
  provider: v.optional(v.string()),
  providerOptions, // Sent to model

  // The result
  message: v.optional(vMessage),
  // Convenience fields extracted from the message
  tool: v.boolean(), // either tool call (assistant) or tool result (tool)
  text: v.optional(v.string()),

  // Result metadata
  usage: v.optional(vUsage),
  providerMetadata: v.optional(vProviderMetadata), // Received from model
  sources: v.optional(v.array(vSource)),
  warnings: v.optional(v.array(vLanguageModelCallWarning)),
  finishReason: v.optional(vFinishReason),
  // Likely deprecated soon
  reasoning: v.optional(v.string()),
  reasoningDetails: v.optional(vReasoningDetails),
  // Deprecated
  id: v.optional(v.string()), // external id, e.g. from Vercel AI SDK
});
export type MessageDoc = Infer<typeof vMessageDoc>; // Public

export const vOnSaveMessagesArgs = v.object({
  threadId: v.string(),
  userId: v.optional(v.string()),
  messages: v.array(vMessageDoc),
});
export type OnSaveMessagesArgs = Infer<typeof vOnSaveMessagesArgs>;

export const vThreadDoc = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  userId: v.optional(v.string()), // Unset for anonymous
  title: v.optional(v.string()),
  summary: v.optional(v.string()),
  status: vThreadStatus,
});
export type ThreadDoc = Infer<typeof vThreadDoc>;
