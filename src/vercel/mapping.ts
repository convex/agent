import {
  type UIMessage as AIMessage,
  type AssistantContent,
  type ModelMessage,
  type DataContent,
  type FilePart,
  type GenerateObjectResult,
  type ImagePart,
  type StepResult,
  type ToolContent,
  type ToolSet,
  type UserContent,
  type FileUIPart,
  type LanguageModelUsage,
  type CallWarning,
  type TextPart,
  type ToolCallPart,
  type ToolResultPart,
  type ProviderMetadata,
  type JSONValue,
} from "ai";
import {
  vMessageWithMetadata,
  type vSourcePart,
  type Message,
  type MessageWithMetadata,
  type Usage,
  type vFilePart,
  type vCustomContentPart,
  type vImagePart,
  type vReasoningFilePart,
  type vReasoningPart,
  type vRedactedReasoningPart,
  type vTextPart,
  type vToolCallPart,
  type vToolResultPart,
  type SourcePart,
  vToolResultOutput,
  type MessageDoc,
  vToolApprovalRequest,
  vToolApprovalResponse,
  vProviderReference,
} from "../validators.js";
import type { ActionCtx, AgentComponent } from "./client/types.js";
import type { MutationCtx } from "./client/types.js";
import { MAX_FILE_SIZE, storeFile } from "./client/files.js";
import { materializeCanonicalToolResultContentFiles } from "./fileMaterialization.js";
import type { Infer } from "convex/values";
import {
  convertUint8ArrayToBase64,
  type FileData,
  type ProviderOptions,
  type ProviderReference,
  type ReasoningFilePart,
  type ReasoningPart,
  type ToolResultOutput,
} from "@ai-sdk/provider-utils";
import { parse, validate } from "convex-helpers/validators";
import {
  getModelName,
  getProviderName,
  type ModelOrMetadata,
} from "../shared.js";
export type AIMessageWithoutId = Omit<AIMessage, "id">;

export type SerializeUrlsAndUint8Arrays<T> = T extends URL
  ? string
  : T extends Uint8Array | ArrayBufferLike
    ? ArrayBuffer
    : T extends Array<infer Inner>
      ? Array<SerializeUrlsAndUint8Arrays<Inner>>
      : T extends Record<string, any>
        ? { [K in keyof T]: SerializeUrlsAndUint8Arrays<T[K]> }
        : T;

export type Content = UserContent | AssistantContent | ToolContent;
export type SerializedContent = Message["content"];

export type SerializedMessage = Message;

export async function serializeMessage(
  ctx: ActionCtx | MutationCtx,
  component: AgentComponent,
  message: ModelMessage | Message,
): Promise<{ message: SerializedMessage; fileIds?: string[] }> {
  const { content, fileIds } = await serializeContent(
    ctx,
    component,
    message.content,
  );
  return {
    message: {
      role: message.role,
      content,
      ...(message.providerOptions
        ? { providerOptions: message.providerOptions }
        : {}),
    } as SerializedMessage,
    fileIds,
  };
}

// Similar to serializeMessage, but doesn't save any files and is looser
// For use on the frontend / in synchronous environments.
export function fromModelMessage(message: ModelMessage): Message {
  const content = fromModelMessageContent(message.content);
  return {
    role: message.role,
    content,
    ...(message.providerOptions
      ? { providerOptions: message.providerOptions }
      : {}),
  } as SerializedMessage;
}

export async function serializeOrThrow(
  message: ModelMessage | Message,
): Promise<SerializedMessage> {
  const { content } = await serializeContent(
    {} as any,
    {} as any,
    message.content,
  );
  return {
    role: message.role,
    content,
    ...(message.providerOptions
      ? { providerOptions: message.providerOptions }
      : {}),
  } as SerializedMessage;
}

export function toModelMessage(
  message: SerializedMessage | ModelMessage,
): ModelMessage {
  return {
    ...message,
    content: toModelMessageContent(message.content),
  } as ModelMessage;
}

export function docsToModelMessages(messages: MessageDoc[]): ModelMessage[] {
  return messages
    .map((m) => m.message)
    .filter((m) => !!m)
    .filter((m) => !!m.content.length)
    .map(toModelMessage);
}

/**
 * Scan messages for unresolved `tool-approval-request` parts and inject
 * synthetic `tool-approval-response` denials so that the AI SDK receives
 * a complete history (every tool-call has a corresponding result or denial).
 *
 * This handles the case where a user sends a new message instead of
 * resolving pending approvals — the old approvals are auto-denied rather
 * than silently dropped.
 */
export function autoDenyUnresolvedApprovals(
  messages: ModelMessage[],
): ModelMessage[] {
  // Collect all approval requests: approvalId → { toolCallId, messageIndex }
  const requests = new Map<
    string,
    { toolCallId: string; messageIndex: number }
  >();
  // Collect all resolved approval IDs
  const resolvedIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content as any[]) {
      if (part.type === "tool-approval-request") {
        requests.set(part.approvalId, {
          toolCallId: part.toolCallId,
          messageIndex: i,
        });
      } else if (part.type === "tool-approval-response") {
        resolvedIds.add(part.approvalId);
      }
    }
  }

  // Find unresolved approvals
  const unresolved: Array<{
    approvalId: string;
    toolCallId: string;
    messageIndex: number;
  }> = [];
  for (const [approvalId, info] of requests) {
    if (!resolvedIds.has(approvalId)) {
      unresolved.push({ approvalId, ...info });
    }
  }

  if (unresolved.length === 0) {
    return messages;
  }

  // Group unresolved approvals by the assistant message index they came from
  const byMessageIndex = new Map<
    number,
    Array<{ approvalId: string; toolCallId: string }>
  >();
  for (const entry of unresolved) {
    console.warn(
      `Auto-denying unresolved tool approval ${entry.approvalId} ` +
        `(toolCallId: ${entry.toolCallId}): new generation started`,
    );
    let group = byMessageIndex.get(entry.messageIndex);
    if (!group) {
      group = [];
      byMessageIndex.set(entry.messageIndex, group);
    }
    group.push(entry);
  }

  // Build result by inserting synthetic denial messages after each relevant
  // assistant message
  const result: ModelMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    result.push(messages[i]);
    const group = byMessageIndex.get(i);
    if (group) {
      result.push({
        role: "tool",
        content: group.map((entry) => ({
          type: "tool-approval-response" as const,
          approvalId: entry.approvalId,
          approved: false,
          reason: "auto-denied: new generation started",
        })),
      });
    }
  }

  return result;
}

export function serializeUsage(usage: LanguageModelUsage): Usage {
  return {
    promptTokens: usage.inputTokens,
    completionTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
    nonCachedInputTokens: usage.inputTokenDetails?.noCacheTokens,
    cacheWriteInputTokens: usage.inputTokenDetails?.cacheWriteTokens,
    textOutputTokens: usage.outputTokenDetails?.textTokens,
    raw: usage.raw,
  };
}

export function serializeWarnings(
  warnings: CallWarning[] | undefined,
): MessageWithMetadata["warnings"] {
  if (!warnings) {
    return undefined;
  }
  return warnings.map((warning) => {
    switch (warning.type) {
      case "unsupported":
      case "compatibility":
        return {
          type: warning.type,
          feature: warning.feature,
          details: warning.details,
        };
      case "deprecated":
        return {
          type: warning.type,
          setting: warning.setting,
          message: warning.message,
        };
      case "other":
        return { type: warning.type, message: warning.message };
    }
  });
}

/**
 * Serialize explicitly provided response messages for a step.
 * Used by the streaming/generation loop where the caller tracks which
 * messages are new via slicing.
 */
export async function serializeResponseMessages<TOOLS extends ToolSet>(
  ctx: ActionCtx,
  component: AgentComponent,
  step: StepResult<TOOLS>,
  model: ModelOrMetadata | undefined,
  responseMessages: ModelMessage[],
): Promise<{ messages: MessageWithMetadata[] }> {
  return serializeStepMessages(ctx, component, step, model, responseMessages);
}

async function serializeStepMessages<TOOLS extends ToolSet>(
  ctx: ActionCtx,
  component: AgentComponent,
  step: StepResult<TOOLS>,
  model: ModelOrMetadata | undefined,
  messagesToSerialize: ModelMessage[],
): Promise<{ messages: MessageWithMetadata[] }> {
  // If there are tool results, there's another message with the tool results
  // ref: https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/to-response-messages.ts#L120
  const hasToolMessage = step.response.messages.at(-1)?.role === "tool";
  const resolvedModel = step.model ?? model;
  const assistantFields = {
    model: resolvedModel ? getModelName(resolvedModel) : undefined,
    provider: resolvedModel ? getProviderName(resolvedModel) : undefined,
    providerMetadata: step.providerMetadata,
    usage: serializeUsage(step.usage),
    warnings: serializeWarnings(step.warnings),
    finishReason: step.finishReason,
    // Only store the sources on one message
    sources: hasToolMessage ? undefined : step.sources,
  } satisfies Omit<MessageWithMetadata, "message" | "text" | "fileIds">;
  const toolFields = { sources: step.sources };

  const messages: MessageWithMetadata[] = await Promise.all(
    messagesToSerialize.map(async (msg): Promise<MessageWithMetadata> => {
      const { message, fileIds } = await serializeMessage(ctx, component, msg);
      return parse(vMessageWithMetadata, {
        message,
        ...(message.role === "tool" ? toolFields : assistantFields),
        text: step.text,
        fileIds,
      });
    }),
  );
  return { messages };
}

export async function serializeObjectResult(
  ctx: ActionCtx,
  component: AgentComponent,
  result: GenerateObjectResult<unknown>,
  model: ModelOrMetadata | undefined,
): Promise<{ messages: MessageWithMetadata[] }> {
  const text = JSON.stringify(result.object);

  const { message, fileIds } = await serializeMessage(ctx, component, {
    role: "assistant" as const,
    content: text,
  });
  return {
    messages: [
      {
        message,
        model: model ? getModelName(model) : undefined,
        provider: model ? getProviderName(model) : undefined,
        providerMetadata: result.providerMetadata,
        finishReason: result.finishReason,
        text,
        usage: serializeUsage(result.usage),
        warnings: serializeWarnings(result.warnings),
        fileIds,
      },
    ],
  };
}

function getMimeOrMediaType(part: { mediaType?: string; mimeType?: string }) {
  if ("mediaType" in part) {
    return part.mediaType;
  }
  if ("mimeType" in part) {
    return part.mimeType;
  }
  return undefined;
}

export async function serializeContent(
  ctx: ActionCtx | MutationCtx,
  component: AgentComponent,
  content: Content | Message["content"],
): Promise<{ content: SerializedContent; fileIds?: string[] }> {
  if (typeof content === "string") {
    return { content };
  }
  const fileIds: string[] = [];
  const serialized = await Promise.all(
    content.map(async (part) => {
      const metadata: {
        providerOptions?: ProviderOptions;
        providerMetadata?: ProviderMetadata;
      } = {};
      if ("providerOptions" in part) {
        metadata.providerOptions = part.providerOptions as ProviderOptions;
      }
      if ("providerMetadata" in part) {
        metadata.providerMetadata = part.providerMetadata as ProviderMetadata;
      }
      switch (part.type) {
        case "text": {
          return {
            type: part.type,
            text: part.text,
            ...metadata,
          } satisfies Infer<typeof vTextPart>;
        }
        case "image": {
          let image =
            toStoredProviderReference(part.image) ??
            serializeDataOrUrl(part.image);
          if (
            image instanceof ArrayBuffer &&
            image.byteLength > MAX_FILE_SIZE
          ) {
            const { file } = await storeFile(
              ctx,
              component,
              new Blob([image], {
                type: getMimeOrMediaType(part) || guessMimeType(image),
              }),
            );
            image = file.url;
            fileIds.push(file.fileId);
          }
          return {
            type: part.type,
            mediaType: getMimeOrMediaType(part),
            ...metadata,
            image,
          } satisfies Infer<typeof vImagePart>;
        }
        case "file": {
          let data =
            toStoredProviderReference(part.data) ??
            serializeDataOrUrl(part.data);
          if (data instanceof ArrayBuffer && data.byteLength > MAX_FILE_SIZE) {
            const { file } = await storeFile(
              ctx,
              component,
              new Blob([data], { type: getMimeOrMediaType(part) }),
            );
            data = file.url;
            fileIds.push(file.fileId);
          }
          return {
            type: part.type,
            data,
            filename: part.filename,
            mediaType: getMimeOrMediaType(part)!,
            ...metadata,
          } satisfies Infer<typeof vFilePart>;
        }
        case "tool-call": {
          // Handle legacy data where only args field exists
          const input = part.input ?? (part as any)?.args ?? {};
          return {
            type: part.type,
            input,
            /** @deprecated Use `input` instead. */
            args: input,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            providerExecuted: part.providerExecuted,
            title: "title" in part ? part.title : undefined,
            toolMetadata:
              "toolMetadata" in part ? part.toolMetadata : undefined,
            ...metadata,
          } satisfies Infer<typeof vToolCallPart>;
        }
        case "tool-result": {
          const output =
            "output" in part && part.output !== undefined
              ? part.output
              : normalizeToolOutput("result" in part ? part.result : undefined);
          const materialized = await materializeCanonicalToolResultContentFiles(
            ctx,
            component,
            output,
          );
          fileIds.push(...materialized.fileRefs.map((ref) => ref.fileId));
          return serializeToolResult(
            { ...part, output: materialized.output } as ToolResultPart,
            metadata,
          );
        }
        case "reasoning": {
          return {
            type: part.type,
            text: part.text,
            signature:
              "signature" in part && typeof part.signature === "string"
                ? part.signature
                : undefined,
            ...metadata,
          } satisfies Infer<typeof vReasoningPart>;
        }
        case "reasoning-file": {
          return {
            type: part.type,
            ...serializeReasoningFile(part),
            mediaType: part.mediaType,
            ...metadata,
          } satisfies Infer<typeof vReasoningFilePart>;
        }
        case "custom": {
          return {
            type: part.type,
            kind: part.kind,
            ...metadata,
          } satisfies Infer<typeof vCustomContentPart>;
        }
        // Not in current generation output, but could be in historical messages
        case "redacted-reasoning": {
          return {
            type: part.type,
            data: part.data,
            ...metadata,
          } satisfies Infer<typeof vRedactedReasoningPart>;
        }
        case "source": {
          return part satisfies Infer<typeof vSourcePart>;
        }
        case "tool-approval-request": {
          return {
            type: part.type,
            approvalId: part.approvalId,
            toolCallId: part.toolCallId,
            isAutomatic: "isAutomatic" in part ? part.isAutomatic : undefined,
            signature: "signature" in part ? part.signature : undefined,
            ...metadata,
          } satisfies Infer<typeof vToolApprovalRequest>;
        }
        case "tool-approval-response": {
          return {
            type: part.type,
            approvalId: part.approvalId,
            approved: part.approved,
            reason: part.reason,
            providerExecuted: part.providerExecuted,
            ...metadata,
          } satisfies Infer<typeof vToolApprovalResponse>;
        }
        default:
          return null;
      }
    }),
  );
  return {
    content: serialized.filter((p) => p !== null) as SerializedContent,
    fileIds: fileIds.length > 0 ? fileIds : undefined,
  };
}

export function fromModelMessageContent(content: Content): Message["content"] {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      const metadata: {
        providerOptions?: ProviderOptions;
        providerMetadata?: ProviderMetadata;
      } = {};
      if ("providerOptions" in part) {
        metadata.providerOptions = part.providerOptions as ProviderOptions;
      }
      if ("providerMetadata" in part) {
        metadata.providerMetadata = part.providerMetadata as ProviderMetadata;
      }
      switch (part.type) {
        case "text":
          return part satisfies Infer<typeof vTextPart>;
        case "image":
          return {
            type: part.type,
            mediaType: getMimeOrMediaType(part),
            ...metadata,
            image:
              toStoredProviderReference(part.image) ??
              serializeDataOrUrl(part.image),
          } satisfies Infer<typeof vImagePart>;
        case "file":
          return {
            type: part.type,
            data:
              toStoredProviderReference(part.data) ??
              serializeDataOrUrl(part.data),
            filename: part.filename,
            mediaType: getMimeOrMediaType(part)!,
            ...metadata,
          } satisfies Infer<typeof vFilePart>;
        case "tool-call":
          // Handle legacy data where only args field exists
          return {
            type: part.type,
            input: part.input ?? (part as any)?.args ?? {},
            /** @deprecated Use `input` instead. */
            args: part.input ?? (part as any)?.args ?? {},
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            providerExecuted: part.providerExecuted,
            ...metadata,
          } satisfies Infer<typeof vToolCallPart>;
        case "tool-result":
          return serializeToolResult(part, metadata);
        case "reasoning":
          return {
            type: part.type,
            text: part.text,
            signature:
              "signature" in part && typeof part.signature === "string"
                ? part.signature
                : undefined,
            ...metadata,
          } satisfies Infer<typeof vReasoningPart>;
        case "reasoning-file": {
          return {
            type: part.type,
            ...serializeReasoningFile(part),
            mediaType: part.mediaType,
            ...metadata,
          } satisfies Infer<typeof vReasoningFilePart>;
        }
        case "custom":
          return {
            type: part.type,
            kind: part.kind,
            ...metadata,
          } satisfies Infer<typeof vCustomContentPart>;
        case "tool-approval-request":
          return {
            type: part.type,
            approvalId: part.approvalId,
            toolCallId: part.toolCallId,
            isAutomatic: "isAutomatic" in part ? part.isAutomatic : undefined,
            signature: "signature" in part ? part.signature : undefined,
            ...metadata,
          } satisfies Infer<typeof vToolApprovalRequest>;
        case "tool-approval-response":
          return {
            type: part.type,
            approvalId: part.approvalId,
            approved: part.approved,
            reason: part.reason,
            providerExecuted: part.providerExecuted,
            ...metadata,
          } satisfies Infer<typeof vToolApprovalResponse>;
        // Not in current generation output, but could be in historical messages
        default:
          return null;
      }
    })
    .filter((p) => p !== null) as Message["content"];
}

export function toModelMessageContent(
  content: SerializedContent | ModelMessage["content"],
): Content {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      const metadata: {
        providerOptions?: ProviderOptions;
        providerMetadata?: ProviderMetadata;
      } = {};
      if ("providerOptions" in part) {
        metadata.providerOptions = part.providerOptions;
      }
      if ("providerMetadata" in part) {
        metadata.providerMetadata = part.providerMetadata;
      }
      switch (part.type) {
        case "text":
          return {
            type: part.type,
            text: part.text,
            ...metadata,
          } satisfies TextPart;
        case "image":
          return {
            type: part.type,
            image: (isStoredProviderReference(part.image)
              ? part.image.reference
              : toModelMessageDataOrUrl(part.image)) as ImagePart["image"],
            mediaType: getMimeOrMediaType(part),
            ...metadata,
          } satisfies ImagePart;
        case "file":
          return {
            type: part.type,
            data: (isStoredProviderReference(part.data)
              ? { type: "reference" as const, reference: part.data.reference }
              : toModelMessageDataOrUrl(part.data)) as FilePart["data"],
            filename: part.filename,
            mediaType: getMimeOrMediaType(part)!,
            ...metadata,
          } satisfies FilePart;
        case "tool-call": {
          // Handle legacy data where only args field exists
          const input = part.input ?? (part as any)?.args ?? {};
          return {
            type: part.type,
            input,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            providerExecuted: part.providerExecuted,
            ...metadata,
          } satisfies ToolCallPart;
        }
        case "tool-result": {
          return deserializeToolResult(part, metadata);
        }
        case "reasoning":
          return {
            type: part.type,
            text: part.text,
            ...metadata,
          } satisfies ReasoningPart;
        case "reasoning-file":
          return {
            type: "reasoning-file",
            data: deserializeReasoningFile(
              part as Infer<typeof vReasoningFilePart>,
            ),
            mediaType: part.mediaType,
            ...metadata,
          } satisfies ReasoningFilePart;
        case "custom":
          return { type: "custom", kind: part.kind, ...metadata };
        case "redacted-reasoning":
          // Legacy v5 part: round-trip the redacted payload via providerOptions.
          return {
            type: "reasoning",
            text: "",
            ...metadata,
            providerOptions: metadata.providerOptions
              ? Object.fromEntries(
                  Object.entries(metadata.providerOptions ?? {}).map(
                    ([key, value]) => [
                      key,
                      { ...value, redactedData: part.data },
                    ],
                  ),
                )
              : undefined,
          } satisfies ReasoningPart;
        case "source":
          return part satisfies SourcePart;
        case "tool-approval-request":
          return {
            type: part.type,
            approvalId: part.approvalId,
            toolCallId: part.toolCallId,
            isAutomatic: "isAutomatic" in part ? part.isAutomatic : undefined,
            signature: "signature" in part ? part.signature : undefined,
            ...metadata,
          } satisfies Infer<typeof vToolApprovalRequest>;
        case "tool-approval-response":
          return {
            type: part.type,
            approvalId: part.approvalId,
            approved: part.approved,
            reason: part.reason,
            providerExecuted: part.providerExecuted,
            ...metadata,
          } satisfies Infer<typeof vToolApprovalResponse>;
        default:
          return null;
      }
    })
    .filter((p) => p !== null) as Content;
}

export function normalizeToolOutput(
  result: string | JSONValue | undefined,
): ToolResultPart["output"] {
  if (typeof result === "string") {
    return {
      type: "text",
      value: result,
    };
  }
  if (validate(vToolResultOutput, result)) {
    return result as unknown as ToolResultOutput;
  }
  return {
    type: "json",
    value: result ?? null,
  };
}

function serializeToolResult(
  part: ToolResultPart | Infer<typeof vToolResultPart>,
  metadata: {
    providerOptions?: ProviderOptions;
    providerMetadata?: ProviderMetadata;
  },
): Infer<typeof vToolResultPart> {
  return {
    type: part.type,
    output:
      "output" in part && part.output !== undefined
        ? serializeToolResultOutput(part.output)
        : (normalizeToolOutput(
            "result" in part ? part.result : undefined,
          ) as Infer<typeof vToolResultOutput>),
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    ...("providerExecuted" in part
      ? { providerExecuted: part.providerExecuted }
      : {}),
    // Preserve isError flag for error reporting
    ...("isError" in part && part.isError ? { isError: true } : {}),
    ...metadata,
  } as Infer<typeof vToolResultPart>;
}

function deserializeToolResult(
  part: ToolResultPart | Infer<typeof vToolResultPart>,
  metadata: {
    providerOptions?: ProviderOptions;
    providerMetadata?: ProviderMetadata;
  },
): ToolResultPart {
  return {
    type: part.type,
    output:
      "output" in part && part.output !== undefined
        ? deserializeToolResultOutput(part.output)
        : normalizeToolOutput("result" in part ? part.result : undefined),
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    ...("isError" in part && part.isError ? { isError: true } : {}),
    ...metadata,
  } satisfies ToolResultPart;
}

function serializeToolResultOutput(
  output: unknown,
): Infer<typeof vToolResultOutput> {
  if (output === undefined) {
    return normalizeToolOutput(undefined) as Infer<typeof vToolResultOutput>;
  }
  if (!isRecord(output) || typeof output.type !== "string") {
    return normalizeToolOutput(output as JSONValue) as Infer<
      typeof vToolResultOutput
    >;
  }
  if (output.type !== "content") {
    if (validate(vToolResultOutput, output)) {
      return output as Infer<typeof vToolResultOutput>;
    }
    throw new Error(`Invalid AI SDK 7 tool-result output: ${output.type}`);
  }
  if (!Array.isArray(output.value)) {
    throw new Error("Invalid AI SDK 7 tool-result content output");
  }
  const serialized = {
    ...output,
    value: output.value.map(serializeToolResultContentPart),
  };
  if (!validate(vToolResultOutput, serialized)) {
    throw new Error("Invalid AI SDK 7 tool-result content part");
  }
  return serialized as Infer<typeof vToolResultOutput>;
}

function serializeToolResultContentPart(part: unknown): unknown {
  if (!isRecord(part) || typeof part.type !== "string") {
    throw new Error("Invalid AI SDK 7 tool-result content part");
  }
  if (part.type !== "file") return part;
  if (!isRecord(part.data) || typeof part.data.type !== "string") {
    throw new Error("Invalid AI SDK 7 tool-result file data");
  }

  const common = {
    type: "file" as const,
    mediaType: part.mediaType,
    ...(typeof part.filename === "string" ? { filename: part.filename } : {}),
    ...(isRecord(part.providerOptions)
      ? { providerOptions: part.providerOptions }
      : {}),
  };
  switch (part.data.type) {
    case "data":
      return {
        ...common,
        data: {
          type: "data" as const,
          data: serializeDataOrUrl(part.data.data as DataContent),
        },
      };
    case "url": {
      const { url } = part.data;
      if (typeof url !== "string" && !(url instanceof URL)) {
        throw new Error("Invalid AI SDK 7 tool-result file URL");
      }
      return { ...common, data: { type: "url" as const, url: url.toString() } };
    }
    case "text":
      if (typeof part.data.text !== "string") {
        throw new Error("Invalid AI SDK 7 tool-result file text");
      }
      return {
        ...common,
        data: { type: "text" as const, text: part.data.text },
      };
    case "reference":
      if (!isProviderReference(part.data.reference)) {
        throw new Error("Invalid AI SDK 7 tool-result file reference");
      }
      return {
        ...common,
        data: { type: "reference" as const, reference: part.data.reference },
      };
    default:
      throw new Error(
        `Invalid AI SDK 7 tool-result file data: ${part.data.type}`,
      );
  }
}

function deserializeToolResultOutput(output: unknown): ToolResultOutput {
  if (!validate(vToolResultOutput, output)) {
    return normalizeToolOutput(output as JSONValue);
  }
  const stored = output as Infer<typeof vToolResultOutput>;
  if (stored.type !== "content") return stored as unknown as ToolResultOutput;
  return {
    type: "content",
    value: stored.value.map(deserializeToolResultContentPart),
  } as ToolResultOutput;
}

function deserializeToolResultContentPart(
  part: Extract<
    Infer<typeof vToolResultOutput>,
    { type: "content" }
  >["value"][number],
) {
  if (part.type === "file") {
    return {
      ...part,
      data:
        part.data.type === "url"
          ? { type: "url" as const, url: new URL(part.data.url) }
          : part.data,
    };
  }
  switch (part.type) {
    case "media":
      return {
        type: "file" as const,
        data: { type: "data" as const, data: part.data },
        mediaType: part.mediaType,
      };
    case "file-data":
      return {
        type: "file" as const,
        data: { type: "data" as const, data: part.data },
        mediaType: part.mediaType,
        ...(part.filename !== undefined ? { filename: part.filename } : {}),
        ...(part.providerOptions !== undefined
          ? { providerOptions: part.providerOptions }
          : {}),
      };
    case "file-url":
      return {
        type: "file" as const,
        data: { type: "url" as const, url: new URL(part.url) },
        mediaType: part.mediaType ?? "application/octet-stream",
        ...(part.providerOptions !== undefined
          ? { providerOptions: part.providerOptions }
          : {}),
      };
    case "file-id":
    case "image-file-id":
      if (typeof part.fileId === "string") return part;
      return {
        type: "file" as const,
        data: {
          type: "reference" as const,
          reference: part.fileId,
        },
        mediaType:
          part.type === "image-file-id" ? "image" : "application/octet-stream",
        ...(part.providerOptions !== undefined
          ? { providerOptions: part.providerOptions }
          : {}),
      };
    case "file-reference":
    case "image-file-reference":
      return {
        type: "file" as const,
        data: { type: "reference" as const, reference: part.providerReference },
        mediaType:
          part.type === "image-file-reference"
            ? "image"
            : "application/octet-stream",
        ...(part.providerOptions !== undefined
          ? { providerOptions: part.providerOptions }
          : {}),
      };
    case "image-data":
      return {
        type: "file" as const,
        data: { type: "data" as const, data: part.data },
        mediaType: part.mediaType,
        ...(part.providerOptions !== undefined
          ? { providerOptions: part.providerOptions }
          : {}),
      };
    case "image-url":
      return {
        type: "file" as const,
        data: { type: "url" as const, url: new URL(part.url) },
        mediaType: "image",
        ...(part.providerOptions !== undefined
          ? { providerOptions: part.providerOptions }
          : {}),
      };
    default:
      return part;
  }
}

function serializeReasoningFile(
  part: ReasoningFilePart | Infer<typeof vReasoningFilePart>,
): Pick<Infer<typeof vReasoningFilePart>, "url" | "data"> {
  if ("url" in part && part.url !== undefined) {
    return { url: part.url.toString() };
  }
  if (!("data" in part) || part.data === undefined) {
    throw new Error("reasoning-file requires data or url");
  }
  const { data } = part;
  if (data instanceof URL) return { url: data.toString() };
  if (isRecord(data) && data.type === "url" && data.url instanceof URL) {
    return { url: data.url.toString() };
  }
  if (isRecord(data) && data.type === "data") {
    return { data: serializeDataOrUrl(data.data as DataContent) };
  }
  if (isRecord(data) && "type" in data) {
    throw new Error("Invalid AI SDK 7 reasoning-file data");
  }
  return { data: serializeDataOrUrl(data) };
}

function deserializeReasoningFile(
  part: Infer<typeof vReasoningFilePart>,
): Extract<ReasoningFilePart["data"], { type: string }> {
  if (part.url !== undefined) {
    return { type: "url", url: new URL(part.url) };
  }
  if (part.data !== undefined) {
    return { type: "data", data: part.data };
  }
  throw new Error("reasoning-file requires data or url");
}

/**
 * Return a best-guess MIME type based on the magic-number signature
 * found at the start of an ArrayBuffer.
 *
 * @param buf – the source ArrayBuffer
 * @returns the detected MIME type, or `"application/octet-stream"` if unknown
 */
export function guessMimeType(buf: ArrayBuffer | string): string {
  if (typeof buf === "string") {
    if (buf.match(/^data:\w+\/\w+;base64/)) {
      return buf.split(";")[0].split(":")[1]!;
    }
    return "text/plain";
  }
  if (buf.byteLength < 4) return "application/octet-stream";

  // Read the first 12 bytes (enough for all signatures below)
  const bytes = new Uint8Array(buf.slice(0, 12));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

  // Helper so we can look at only the needed prefix
  const startsWith = (sig: string) => hex.startsWith(sig.toLowerCase());

  // --- image formats ---
  if (startsWith("89504e47")) return "image/png"; // PNG  - 89 50 4E 47
  if (
    startsWith("ffd8ffdb") ||
    startsWith("ffd8ffe0") ||
    startsWith("ffd8ffee") ||
    startsWith("ffd8ffe1")
  )
    return "image/jpeg"; // JPEG
  if (startsWith("47494638")) return "image/gif"; // GIF
  if (startsWith("424d")) return "image/bmp"; // BMP
  if (startsWith("52494646") && hex.substr(16, 8) === "57454250")
    return "image/webp"; // WEBP (RIFF....WEBP)
  if (startsWith("49492a00")) return "image/tiff"; // TIFF
  // <svg in hex is 3c 3f 78 6d 6c
  if (startsWith("3c737667")) return "image/svg+xml"; // <svg
  if (startsWith("3c3f786d")) return "image/svg+xml"; // <?xm

  // --- audio/video ---
  if (startsWith("494433")) return "audio/mpeg"; // MP3 (ID3)
  if (startsWith("000001ba") || startsWith("000001b3")) return "video/mpeg"; // MPEG container
  if (startsWith("1a45dfa3")) return "video/webm"; // WEBM / Matroska
  if (startsWith("00000018") && hex.substr(16, 8) === "66747970")
    return "video/mp4"; // MP4
  if (startsWith("4f676753")) return "audio/ogg"; // OGG / Opus

  // --- documents & archives ---
  if (startsWith("25504446")) return "application/pdf"; // PDF
  if (
    startsWith("504b0304") ||
    startsWith("504b0506") ||
    startsWith("504b0708")
  )
    return "application/zip"; // ZIP / DOCX / PPTX / XLSX / EPUB
  if (startsWith("52617221")) return "application/x-rar-compressed"; // RAR
  if (startsWith("7f454c46")) return "application/x-elf"; // ELF binaries
  if (startsWith("1f8b08")) return "application/gzip"; // GZIP
  if (startsWith("425a68")) return "application/x-bzip2"; // BZIP2
  if (startsWith("3c3f786d6c")) return "application/xml"; // XML

  // Plain text, JSON and others are trickier—fallback:
  return "application/octet-stream";
}

/**
 * Serialize an AI SDK `DataContent` or `URL` to a Convex-serializable format.
 * @param dataOrUrl - The data or URL to serialize.
 * @returns The serialized data as an ArrayBuffer or the URL as a string.
 */
export function serializeDataOrUrl(
  dataOrUrl: DataContent | URL | ProviderReference | FileData,
): ArrayBuffer | string {
  if (typeof dataOrUrl === "string") {
    return dataOrUrl;
  }
  if (dataOrUrl instanceof ArrayBuffer) {
    return dataOrUrl; // Already an ArrayBuffer
  }
  if (dataOrUrl instanceof URL) {
    return dataOrUrl.toString();
  }
  if ("type" in dataOrUrl) {
    switch (dataOrUrl.type) {
      case "data":
        return serializeDataOrUrl(dataOrUrl.data);
      case "url":
        return dataOrUrl.url.toString();
      case "text":
        return convertUint8ArrayToBase64(
          new TextEncoder().encode(dataOrUrl.text),
        );
      case "reference":
        throw new Error("Provider references must be stored as references");
    }
  }
  if (!(dataOrUrl instanceof Uint8Array)) {
    throw new Error("Unsupported provider reference");
  }
  return dataOrUrl.buffer.slice(
    dataOrUrl.byteOffset,
    dataOrUrl.byteOffset + dataOrUrl.byteLength,
  ) as ArrayBuffer;
}

export function toModelMessageDataOrUrl(
  urlOrString:
    | string
    | ArrayBuffer
    | URL
    | DataContent
    | ProviderReference
    | FileData,
): URL | DataContent | ProviderReference | FileData {
  if (urlOrString instanceof URL) {
    return urlOrString;
  }
  if (typeof urlOrString === "string") {
    if (
      urlOrString.startsWith("http://") ||
      urlOrString.startsWith("https://")
    ) {
      return new URL(urlOrString);
    }
    return urlOrString;
  }
  return urlOrString;
}

type StoredProviderReference = Infer<typeof vProviderReference>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProviderReference(value: unknown): value is ProviderReference {
  return (
    isRecord(value) &&
    !(value instanceof ArrayBuffer) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof URL) &&
    !("type" in value) &&
    Object.values(value).every((id) => typeof id === "string")
  );
}

function isStoredProviderReference(
  value: unknown,
): value is StoredProviderReference {
  return (
    isRecord(value) &&
    value.type === "reference" &&
    isProviderReference(value.reference)
  );
}

function toStoredProviderReference(
  value: unknown,
): StoredProviderReference | undefined {
  if (isStoredProviderReference(value)) return value;
  if (isProviderReference(value))
    return { type: "reference", reference: value };
  if (
    isRecord(value) &&
    value.type === "reference" &&
    isProviderReference(value.reference)
  ) {
    return { type: "reference", reference: value.reference };
  }
  return undefined;
}

function isFileReference(
  value: unknown,
): value is { type: "reference"; reference: ProviderReference } {
  return (
    isRecord(value) &&
    value.type === "reference" &&
    isProviderReference(value.reference)
  );
}

export function toUIFilePart(part: ImagePart | FilePart): FileUIPart {
  const dataOrUrl = part.type === "image" ? part.image : part.data;
  const providerReference = isProviderReference(dataOrUrl)
    ? dataOrUrl
    : isFileReference(dataOrUrl)
      ? dataOrUrl.reference
      : undefined;
  const url = providerReference
    ? ""
    : toUIFileUrl(dataOrUrl, part.mediaType ?? "application/octet-stream");

  return {
    type: "file",
    mediaType: part.mediaType!,
    filename: part.type === "file" ? part.filename : undefined,
    url,
    ...(providerReference !== undefined ? { providerReference } : {}),
    providerMetadata: part.providerOptions,
  };
}

function toUIFileUrl(data: unknown, mediaType: string): string {
  if (isFileReference(data)) return "";
  if (isRecord(data) && typeof data.type === "string") {
    switch (data.type) {
      case "url":
        return (data.url as URL).toString();
      case "data":
        return toUIFileDataUrl(data.data as DataContent, mediaType);
      case "text":
        return toUIFileDataUrl(
          new TextEncoder().encode(data.text as string),
          mediaType,
        );
    }
  }
  if (data instanceof URL) return data.toString();
  if (typeof data === "string") return data;
  return toUIFileDataUrl(data as DataContent, mediaType);
}

function toUIFileDataUrl(data: DataContent, mediaType: string): string {
  if (typeof data === "string") {
    return data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
  }
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return `data:${mediaType};base64,${convertUint8ArrayToBase64(bytes)}`;
}
