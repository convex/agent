import {
  vToolResultOutput,
  type Message,
  type MessageContentParts,
  type MessageWithMetadataInternal,
  type StreamDelta,
  type StreamMessage,
} from "../validators.js";
import { validate } from "convex-helpers/validators";
import {
  collectContiguousStreamParts,
  createPersistedUIMessageChunkState,
  PersistedUIMessageChunkError,
  reducePersistedUIMessageChunks,
  setParsedToolInput,
  type PersistedSourcePart,
  type PersistedToolPart,
  type PersistedUIMessagePart,
} from "./persistedUIMessageChunks.js";

type AssistantContentPart = Exclude<
  Extract<Message, { role: "assistant" }>["content"],
  string
>[number];
type ToolContentPart = Extract<Message, { role: "tool" }>["content"][number];
export type PersistedStreamMetadata = {
  status: "success" | "failed";
  error?: string;
};

/** Projects persisted UI-message chunks into durable component messages. */
export function projectPersistedUIMessageChunks(
  stream: StreamMessage,
  chunks: readonly unknown[],
  metadata: PersistedStreamMetadata,
  fileRefs: readonly { url: string; fileId: string }[] = [],
): MessageWithMetadataInternal[] {
  if (stream.format !== "UIMessageChunk") {
    throw new Error(
      `projectPersistedUIMessageChunks: unsupported stream format "${stream.format ?? "text"}" for stream ${stream.streamId}`,
    );
  }
  validatePersistedUIMessageChunkIds(stream.streamId, chunks);
  let reduced;
  try {
    reduced = reducePersistedUIMessageChunks(
      createPersistedUIMessageChunkState(),
      chunks,
    );
  } catch (error) {
    throw persistedProjectionError(error);
  }
  for (const toolCallId of reduced.touchedToolCallIds) {
    setParsedToolInput(
      reduced.state,
      toolCallId,
      parseCompleteJson(reduced.state.toolInputText.get(toolCallId) ?? ""),
    );
  }
  return projectPersistedUIMessageChunkParts(
    reduced.state.parts,
    stream,
    metadata,
    fileRefs,
  );
}

export function getPersistedUIMessageChunkParts(
  deltas: readonly StreamDelta[],
  fromCursor = 0,
): { parts: unknown[]; cursor: number } {
  return collectContiguousStreamParts(deltas, fromCursor);
}

export function validatePersistedUIMessageChunkIds(
  streamId: string,
  chunks: readonly unknown[],
) {
  for (const value of chunks) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const chunk = value as Record<string, unknown>;
    if (
      chunk.type === "start" &&
      typeof chunk.messageId === "string" &&
      chunk.messageId !== `stream:${streamId}`
    ) {
      throw new Error("Expecting to only make one UIMessage in a stream");
    }
  }
}

export function projectPersistedUIMessageChunkParts(
  parts: PersistedUIMessagePart[],
  stream: StreamMessage,
  metadata: PersistedStreamMetadata,
  fileRefs: readonly { url: string; fileId: string }[] = [],
): MessageWithMetadataInternal[] {
  const blocks: PersistedUIMessagePart[][] = [];
  let block: PersistedUIMessagePart[] = [];
  const flush = () => {
    if (block.length > 0) blocks.push(block);
    block = [];
  };
  for (const part of parts) {
    if (part.type === "step-start") {
      flush();
    } else if (
      part.type === "text" ||
      part.type === "reasoning" ||
      part.type === "file" ||
      part.type === "reasoning-file" ||
      part.type === "custom" ||
      part.type === "source-url" ||
      part.type === "source-document" ||
      isToolPart(part) ||
      part.type.startsWith("data-")
    ) {
      block.push(part);
    }
  }
  flush();

  const messages: Array<{
    message: Message;
    sources: ReturnType<typeof projectSources>;
  }> = [];
  for (const current of blocks) {
    const sources = projectSources(current);
    const assistantContent: AssistantContentPart[] = [];
    const tools = current.filter(isToolPart);
    for (const part of current) {
      if (part.type === "text") {
        assistantContent.push({
          type: "text",
          text: part.text,
          ...(part.providerMetadata
            ? { providerOptions: part.providerMetadata }
            : {}),
        });
      } else if (part.type === "reasoning") {
        assistantContent.push({
          type: "reasoning",
          text: part.text,
          ...(part.providerMetadata
            ? { providerOptions: part.providerMetadata }
            : {}),
        });
      } else if (part.type === "file") {
        assistantContent.push({
          type: "file",
          data: part.url,
          ...(part.filename ? { filename: part.filename } : {}),
          mediaType: part.mediaType,
          ...(part.providerMetadata
            ? { providerOptions: part.providerMetadata }
            : {}),
        });
      } else if (part.type === "reasoning-file") {
        assistantContent.push({
          type: "reasoning-file",
          url: part.url,
          mediaType: part.mediaType,
          ...(part.providerMetadata
            ? { providerOptions: part.providerMetadata }
            : {}),
        });
      } else if (part.type === "custom") {
        assistantContent.push({
          type: "custom",
          kind: part.kind,
          ...(part.providerMetadata
            ? { providerOptions: part.providerMetadata }
            : {}),
        });
      } else if (isToolPart(part) && part.state !== "input-streaming") {
        const input =
          part.state === "output-error"
            ? (part.input ?? part.rawInput ?? {})
            : (part.input ?? {});
        assistantContent.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: getToolName(part),
          input,
          args: input,
          providerExecuted: part.providerExecuted,
          ...(part.title ? { title: part.title } : {}),
          ...(part.toolMetadata ? { toolMetadata: part.toolMetadata } : {}),
          ...(part.callProviderMetadata
            ? { providerOptions: part.callProviderMetadata }
            : {}),
        });
        if (part.approval) {
          assistantContent.push({
            type: "tool-approval-request",
            approvalId: part.approval.id,
            toolCallId: part.toolCallId,
            ...(part.approval.isAutomatic !== undefined
              ? { isAutomatic: part.approval.isAutomatic }
              : {}),
            ...(part.approval.signature
              ? { signature: part.approval.signature }
              : {}),
          });
        }
        if (
          part.providerExecuted === true &&
          part.state !== "approval-responded" &&
          (part.state === "output-available" || part.state === "output-error")
        ) {
          assistantContent.push(
            toolResult(
              part,
              part.state === "output-error" ? "error-json" : "normal",
            ),
          );
        }
      }
    }
    if (assistantContent.length > 0) {
      messages.push({
        message: { role: "assistant", content: assistantContent },
        sources,
      });
    }

    const toolContent: ToolContentPart[] = [];
    for (const part of tools) {
      if (part.approval?.approved !== undefined) {
        toolContent.push({
          type: "tool-approval-response",
          approvalId: part.approval.id,
          approved: part.approval.approved,
          reason: part.approval.reason,
          providerExecuted: part.providerExecuted,
        });
      }
      if (
        part.state === "approval-responded" &&
        part.approval?.approved === false
      ) {
        toolContent.push(
          toolResult(part, "execution-denied", part.approval.reason),
        );
      }
      if (part.providerExecuted === true) continue;
      if (part.state === "output-denied") {
        toolContent.push(
          toolResult(part, "execution-denied", part.approval?.reason),
        );
      } else if (part.state === "output-error") {
        toolContent.push(toolResult(part, "error-text"));
      } else if (part.state === "output-available") {
        toolContent.push(toolResult(part, "normal"));
      }
    }
    if (toolContent.length > 0) {
      messages.push({
        message: { role: "tool", content: toolContent },
        sources: [],
      });
    }
  }

  return messages.map(({ message, sources }) => {
    const content = Array.isArray(message.content) ? message.content : [];
    const providerMetadataValue = content.find(
      (part) => part.providerOptions !== undefined,
    )?.providerOptions;
    const hasToolCall =
      message.role === "tool" ||
      content.some((part) => part.type === "tool-call");
    const fileIds = referencedFileIds(message, fileRefs);
    return {
      message,
      status: metadata.status,
      finishReason: hasToolCall ? "tool-calls" : "stop",
      model: stream.model,
      provider: stream.provider,
      ...(providerMetadataValue
        ? { providerMetadata: providerMetadataValue }
        : {}),
      sources,
      ...(fileIds.length > 0
        ? { fileIds: fileIds as MessageWithMetadataInternal["fileIds"] }
        : {}),
      ...(metadata.error !== undefined ? { error: metadata.error } : {}),
    } satisfies MessageWithMetadataInternal;
  });
}

function projectSources(parts: PersistedUIMessagePart[]) {
  return parts
    .filter((part): part is PersistedSourcePart =>
      ["source-url", "source-document"].includes(part.type),
    )
    .map((part) =>
      part.type === "source-url"
        ? {
            type: "source" as const,
            sourceType: "url" as const,
            url: part.url,
            id: part.sourceId,
            providerMetadata: part.providerMetadata,
            title: part.title,
          }
        : {
            type: "source" as const,
            sourceType: "document" as const,
            mediaType: part.mediaType,
            id: part.sourceId,
            providerMetadata: part.providerMetadata,
            title: part.title,
            filename: part.filename,
          },
    );
}

function referencedFileIds(
  message: Message,
  fileRefs: readonly { url: string; fileId: string }[],
) {
  if (typeof message.content === "string") return [];
  const urls = new Set<string>();
  for (const part of message.content) {
    if (part.type === "file") {
      if (typeof part.data === "string") urls.add(part.data);
    } else if (part.type === "reasoning-file") {
      if ("url" in part && part.url) urls.add(part.url);
    } else if (part.type === "tool-result" && part.output?.type === "content") {
      for (const outputPart of part.output.value) {
        if (
          outputPart.type === "file" &&
          outputPart.data.type === "url" &&
          typeof outputPart.data.url === "string"
        ) {
          urls.add(outputPart.data.url);
        }
      }
    }
  }
  return [
    ...new Set(
      fileRefs.filter((ref) => urls.has(ref.url)).map((ref) => ref.fileId),
    ),
  ];
}

function toolResult(
  part: PersistedToolPart,
  mode: "normal" | "error-text" | "error-json" | "execution-denied",
  deniedReason?: string,
): Extract<MessageContentParts, { type: "tool-result" }> {
  const raw =
    mode === "execution-denied"
      ? deniedReason
      : part.state === "output-error"
        ? part.errorText
        : part.output;
  const output =
    mode === "execution-denied"
      ? {
          type: "execution-denied" as const,
          ...(deniedReason !== undefined ? { reason: deniedReason } : {}),
        }
      : mode === "error-text"
        ? { type: "error-text" as const, value: String(raw) }
        : mode === "error-json"
          ? { type: "error-json" as const, value: raw ?? null }
          : validate(vToolResultOutput, raw)
            ? (raw as Extract<
                MessageContentParts,
                { type: "tool-result" }
              >["output"])
            : typeof raw === "string"
              ? { type: "text" as const, value: raw }
              : { type: "json" as const, value: raw ?? null };
  const providerOptions =
    part.resultProviderMetadata ?? part.callProviderMetadata;
  return {
    type: "tool-result",
    toolCallId: part.toolCallId,
    toolName: getToolName(part),
    output,
    ...(providerOptions ? { providerOptions } : {}),
  };
}

function isToolPart(part: PersistedUIMessagePart): part is PersistedToolPart {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

function getToolName(part: PersistedToolPart): string {
  if (part.type === "dynamic-tool") {
    if (!part.toolName)
      throw new Error("Dynamic tool part is missing toolName");
    return part.toolName;
  }
  // AI SDK's UI wire format encodes static tools as `tool-${name}`.
  if (!part.type.startsWith("tool-")) {
    throw new Error(`Invalid static tool part type "${part.type}"`);
  }
  return part.type.slice("tool-".length);
}

function parseCompleteJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function persistedProjectionError(error: unknown): Error {
  if (!(error instanceof PersistedUIMessageChunkError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  if (error.code === "missing-approval") {
    return new Error(
      `Persisted tool-output-denied for tool call "${error.id}" requires a preceding approval request.`,
    );
  }
  if (error.code === "unsupported-chunk") {
    return new Error(`unsupported durable chunk type "${error.chunkType}"`);
  }
  return new Error(
    `Received ${error.chunkType} for missing ${error.partType} part with ID "${error.id}".`,
  );
}
