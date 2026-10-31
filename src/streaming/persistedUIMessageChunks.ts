import type { ProviderMetadata, StreamDelta } from "../validators.js";

export type PersistedUIMessageChunkRecord = Record<string, unknown> & {
  type: string;
};

export class PersistedUIMessageChunkError extends Error {
  constructor(
    readonly code: "missing-part" | "missing-approval" | "unsupported-chunk",
    message: string,
    readonly chunkType: string,
    readonly id?: string,
    readonly partType?: string,
  ) {
    super(message);
  }
}

export type PersistedTextPart = {
  type: "text";
  text: string;
  state: "streaming" | "done";
  providerMetadata?: ProviderMetadata;
};

export type PersistedReasoningPart = {
  type: "reasoning";
  text: string;
  state: "streaming" | "done";
  providerMetadata?: ProviderMetadata;
};

export type PersistedFilePart = {
  type: "file";
  url: string;
  mediaType: string;
  filename?: string;
  providerMetadata?: ProviderMetadata;
};

export type PersistedReasoningFilePart = {
  type: "reasoning-file";
  url: string;
  mediaType: string;
  providerMetadata?: ProviderMetadata;
};

export type PersistedCustomPart = {
  type: "custom";
  kind: string;
  providerMetadata?: ProviderMetadata;
};

export type PersistedSourcePart =
  | {
      type: "source-url";
      sourceId: string;
      url: string;
      title?: string;
      providerMetadata?: ProviderMetadata;
    }
  | {
      type: "source-document";
      sourceId: string;
      mediaType: string;
      title: string;
      filename?: string;
      providerMetadata?: ProviderMetadata;
    };

export type PersistedToolPart = {
  type: `tool-${string}` | "dynamic-tool";
  toolName?: string;
  toolCallId: string;
  state:
    | "input-streaming"
    | "input-available"
    | "approval-requested"
    | "approval-responded"
    | "output-available"
    | "output-error"
    | "output-denied";
  input?: unknown;
  rawInput?: unknown;
  output?: unknown;
  errorText?: string;
  providerExecuted?: boolean;
  callProviderMetadata?: ProviderMetadata;
  resultProviderMetadata?: ProviderMetadata;
  preliminary?: boolean;
  title?: string;
  toolMetadata?: Record<string, unknown>;
  approval?: {
    id: string;
    approved?: boolean;
    reason?: string;
    isAutomatic?: boolean;
    signature?: string;
  };
};

export type PersistedDataPart = {
  type: `data-${string}`;
  id?: string;
  data: unknown;
};

export type PersistedUIMessagePart =
  | PersistedTextPart
  | PersistedReasoningPart
  | PersistedFilePart
  | PersistedReasoningFilePart
  | PersistedCustomPart
  | PersistedSourcePart
  | PersistedToolPart
  | PersistedDataPart
  | { type: "step-start" };

/** Incremental state for persisted UI-message chunks without a provider SDK. */
export type PersistedUIMessageChunkState = {
  readonly format: "UIMessageChunk";
  parts: PersistedUIMessagePart[];
  activeText: Map<string, number>;
  activeReasoning: Map<string, number>;
  toolIndexById: Map<string, number>;
  toolInputText: Map<string, string>;
};

export function createPersistedUIMessageChunkState(): PersistedUIMessageChunkState {
  return {
    format: "UIMessageChunk",
    parts: [],
    activeText: new Map(),
    activeReasoning: new Map(),
    toolIndexById: new Map(),
    toolInputText: new Map(),
  };
}

export function reducePersistedUIMessageChunks(
  previous: PersistedUIMessageChunkState,
  chunks: readonly unknown[],
): {
  state: PersistedUIMessageChunkState;
  touchedToolCallIds: string[];
} {
  const parts = structuredClone(previous.parts);
  const activeText = new Map(previous.activeText);
  const activeReasoning = new Map(previous.activeReasoning);
  const toolIndexById = new Map(previous.toolIndexById);
  const toolInputText = new Map(previous.toolInputText);
  const touchedToolCallIds = new Set<string>();
  const toolPart = (toolCallId: string): PersistedToolPart | undefined => {
    const index = toolIndexById.get(toolCallId);
    return index === undefined
      ? undefined
      : (parts[index] as PersistedToolPart | undefined);
  };
  const addToolPart = (part: PersistedToolPart) => {
    parts.push(part);
    toolIndexById.set(part.toolCallId, parts.length - 1);
    return part;
  };

  chunkLoop: for (const value of chunks) {
    const chunk = chunkRecord(value);
    assertSupportedPersistedUIMessageChunk(chunk);
    switch (chunk.type) {
      case "text-start": {
        const part: PersistedTextPart = {
          type: "text",
          text: "",
          state: "streaming",
          providerMetadata: providerMetadata(chunk.providerMetadata),
        };
        parts.push(part);
        activeText.set(stringField(chunk, "id"), parts.length - 1);
        break;
      }
      case "text-delta": {
        const id = stringField(chunk, "id");
        const index = activeText.get(id);
        if (index === undefined) {
          throw missingPart(chunk.type, id, "text");
        }
        const part = parts[index] as PersistedTextPart;
        part.text += stringField(chunk, "delta");
        part.providerMetadata =
          providerMetadata(chunk.providerMetadata) ?? part.providerMetadata;
        break;
      }
      case "text-end": {
        const id = stringField(chunk, "id");
        const index = activeText.get(id);
        if (index === undefined) {
          throw missingPart(chunk.type, id, "text");
        }
        const part = parts[index] as PersistedTextPart;
        part.state = "done";
        part.providerMetadata =
          providerMetadata(chunk.providerMetadata) ?? part.providerMetadata;
        activeText.delete(id);
        break;
      }
      case "reasoning-start": {
        const part: PersistedReasoningPart = {
          type: "reasoning",
          text: "",
          state: "streaming",
          providerMetadata: providerMetadata(chunk.providerMetadata),
        };
        parts.push(part);
        activeReasoning.set(stringField(chunk, "id"), parts.length - 1);
        break;
      }
      case "reasoning-delta": {
        const id = stringField(chunk, "id");
        const index = activeReasoning.get(id);
        if (index === undefined) {
          throw missingPart(chunk.type, id, "reasoning");
        }
        const part = parts[index] as PersistedReasoningPart;
        part.text += stringField(chunk, "delta");
        part.providerMetadata =
          providerMetadata(chunk.providerMetadata) ?? part.providerMetadata;
        break;
      }
      case "reasoning-end": {
        const id = stringField(chunk, "id");
        const index = activeReasoning.get(id);
        if (index === undefined) {
          throw missingPart(chunk.type, id, "reasoning");
        }
        const part = parts[index] as PersistedReasoningPart;
        part.state = "done";
        part.providerMetadata =
          providerMetadata(chunk.providerMetadata) ?? part.providerMetadata;
        activeReasoning.delete(id);
        break;
      }
      case "tool-input-start": {
        const toolCallId = stringField(chunk, "toolCallId");
        const toolName = stringField(chunk, "toolName");
        const dynamic = chunk.dynamic === true;
        addToolPart({
          type: dynamic ? "dynamic-tool" : `tool-${toolName}`,
          toolName: dynamic ? toolName : undefined,
          toolCallId,
          state: "input-streaming",
          providerExecuted: optionalBoolean(chunk.providerExecuted),
          callProviderMetadata: providerMetadata(chunk.providerMetadata),
          title: optionalString(chunk.title),
          toolMetadata: optionalRecord(chunk.toolMetadata),
        });
        toolInputText.set(toolCallId, "");
        break;
      }
      case "tool-input-delta": {
        const toolCallId = stringField(chunk, "toolCallId");
        if (!toolIndexById.has(toolCallId)) {
          throw missingPart(chunk.type, toolCallId, "tool call");
        }
        toolInputText.set(
          toolCallId,
          (toolInputText.get(toolCallId) ?? "") +
            stringField(chunk, "inputTextDelta"),
        );
        touchedToolCallIds.add(toolCallId);
        break;
      }
      case "tool-input-available": {
        const toolCallId = stringField(chunk, "toolCallId");
        const toolName = stringField(chunk, "toolName");
        const dynamic = chunk.dynamic === true;
        const part =
          toolPart(toolCallId) ??
          addToolPart({
            type: dynamic ? "dynamic-tool" : `tool-${toolName}`,
            toolName: dynamic ? toolName : undefined,
            toolCallId,
            state: "input-available",
          });
        Object.assign(part, {
          state: "input-available" as const,
          input: chunk.input,
          callProviderMetadata:
            providerMetadata(chunk.providerMetadata) ??
            part.callProviderMetadata,
          title: optionalString(chunk.title) ?? part.title,
          toolMetadata: optionalRecord(chunk.toolMetadata) ?? part.toolMetadata,
          providerExecuted:
            optionalBoolean(chunk.providerExecuted) ?? part.providerExecuted,
        });
        touchedToolCallIds.delete(toolCallId);
        toolInputText.delete(toolCallId);
        break;
      }
      case "tool-input-error": {
        const toolCallId = stringField(chunk, "toolCallId");
        const toolName = stringField(chunk, "toolName");
        const dynamic = chunk.dynamic === true;
        const part =
          toolPart(toolCallId) ??
          addToolPart({
            type: dynamic ? "dynamic-tool" : `tool-${toolName}`,
            toolName: dynamic ? toolName : undefined,
            toolCallId,
            state: "output-error",
          });
        Object.assign(part, {
          state: "output-error" as const,
          errorText: stringField(chunk, "errorText"),
          ...(part.type === "dynamic-tool"
            ? { input: chunk.input, rawInput: undefined }
            : { input: undefined, rawInput: chunk.input }),
          resultProviderMetadata:
            providerMetadata(chunk.providerMetadata) ??
            part.resultProviderMetadata,
          title: optionalString(chunk.title) ?? part.title,
          toolMetadata: optionalRecord(chunk.toolMetadata) ?? part.toolMetadata,
          providerExecuted:
            optionalBoolean(chunk.providerExecuted) ?? part.providerExecuted,
        });
        touchedToolCallIds.delete(toolCallId);
        toolInputText.delete(toolCallId);
        break;
      }
      case "tool-output-available": {
        const toolCallId = stringField(chunk, "toolCallId");
        const part = toolPart(toolCallId);
        if (!part) {
          // The result of a tool called before this stream (e.g. an approved
          // one), which its generation saves on its own.
          break;
        }
        Object.assign(part, {
          state: "output-available" as const,
          output: chunk.output,
          preliminary: optionalBoolean(chunk.preliminary),
          providerExecuted:
            optionalBoolean(chunk.providerExecuted) ?? part.providerExecuted,
          resultProviderMetadata:
            providerMetadata(chunk.providerMetadata) ??
            part.resultProviderMetadata,
          toolMetadata: optionalRecord(chunk.toolMetadata) ?? part.toolMetadata,
        });
        break;
      }
      case "tool-output-error": {
        const toolCallId = stringField(chunk, "toolCallId");
        const part = toolPart(toolCallId);
        if (!part) {
          break;
        }
        Object.assign(part, {
          state: "output-error" as const,
          errorText: stringField(chunk, "errorText"),
          output: undefined,
          preliminary: undefined,
          providerExecuted:
            optionalBoolean(chunk.providerExecuted) ?? part.providerExecuted,
          resultProviderMetadata:
            providerMetadata(chunk.providerMetadata) ??
            part.resultProviderMetadata,
          toolMetadata: optionalRecord(chunk.toolMetadata) ?? part.toolMetadata,
        });
        break;
      }
      case "tool-output-denied": {
        const toolCallId = stringField(chunk, "toolCallId");
        const part = toolPart(toolCallId);
        if (!part) {
          break;
        }
        if (!part.approval) {
          throw new PersistedUIMessageChunkError(
            "missing-approval",
            `Received tool-output-denied for tool call with ID "${toolCallId}" without a preceding tool-approval-request.`,
            chunk.type,
            toolCallId,
          );
        }
        part.state = "output-denied";
        break;
      }
      case "tool-approval-request": {
        const toolCallId = stringField(chunk, "toolCallId");
        const part = toolPart(toolCallId);
        if (!part) {
          break chunkLoop;
        }
        part.state = "approval-requested";
        part.approval = {
          id: stringField(chunk, "approvalId"),
          isAutomatic: optionalBoolean(chunk.isAutomatic),
          signature: optionalString(chunk.signature),
        };
        break;
      }
      case "tool-approval-response": {
        const approvalId = stringField(chunk, "approvalId");
        const part = parts.find(
          (candidate): candidate is PersistedToolPart =>
            isToolPart(candidate) && candidate.approval?.id === approvalId,
        );
        if (!part) {
          break chunkLoop;
        }
        part.state = "approval-responded";
        part.approval = {
          ...part.approval!,
          approved: booleanField(chunk, "approved"),
          reason: optionalString(chunk.reason),
        };
        part.providerExecuted =
          optionalBoolean(chunk.providerExecuted) ?? part.providerExecuted;
        part.callProviderMetadata =
          providerMetadata(chunk.providerMetadata) ?? part.callProviderMetadata;
        break;
      }
      case "custom":
        parts.push({
          type: "custom",
          kind: stringField(chunk, "kind"),
          providerMetadata: providerMetadata(chunk.providerMetadata),
        });
        break;
      case "source-url":
        parts.push({
          type: "source-url",
          sourceId: stringField(chunk, "sourceId"),
          url: stringField(chunk, "url"),
          title: optionalString(chunk.title),
          providerMetadata: providerMetadata(chunk.providerMetadata),
        });
        break;
      case "source-document":
        parts.push({
          type: "source-document",
          sourceId: stringField(chunk, "sourceId"),
          mediaType: stringField(chunk, "mediaType"),
          title: stringField(chunk, "title"),
          filename: optionalString(chunk.filename),
          providerMetadata: providerMetadata(chunk.providerMetadata),
        });
        break;
      case "file":
        parts.push({
          type: "file",
          mediaType: stringField(chunk, "mediaType"),
          url: stringField(chunk, "url"),
          filename: optionalString(chunk.filename),
          providerMetadata: providerMetadata(chunk.providerMetadata),
        });
        break;
      case "reasoning-file":
        parts.push({
          type: "reasoning-file",
          mediaType: stringField(chunk, "mediaType"),
          url: stringField(chunk, "url"),
          providerMetadata: providerMetadata(chunk.providerMetadata),
        });
        break;
      case "start-step":
        parts.push({ type: "step-start" });
        break;
      case "finish-step":
        activeText.clear();
        activeReasoning.clear();
        break;
      case "start":
      case "finish":
      case "message-metadata":
      case "error":
      case "abort":
        break;
      default:
        if (chunk.type.startsWith("data-")) {
          if (chunk.transient === true) break;
          const id = optionalString(chunk.id);
          const existingIndex =
            id === undefined
              ? -1
              : parts.findIndex(
                  (part) =>
                    part.type === chunk.type && "id" in part && part.id === id,
                );
          if (existingIndex >= 0) {
            (parts[existingIndex] as PersistedDataPart).data = chunk.data;
          } else {
            parts.push({
              type: chunk.type as `data-${string}`,
              id,
              data: chunk.data,
            });
          }
        } else {
          throw new PersistedUIMessageChunkError(
            "unsupported-chunk",
            `Unsupported durable UI message chunk type "${chunk.type}"`,
            chunk.type,
          );
        }
    }
  }

  return {
    state: {
      format: "UIMessageChunk",
      parts,
      activeText,
      activeReasoning,
      toolIndexById,
      toolInputText,
    },
    touchedToolCallIds: [...touchedToolCallIds],
  };
}

export function setParsedToolInput(
  state: PersistedUIMessageChunkState,
  toolCallId: string,
  input: unknown,
): void {
  const index = state.toolIndexById.get(toolCallId);
  if (index === undefined) return;
  const part = state.parts[index];
  if (part && isToolPart(part) && part.input === undefined) {
    part.input = input;
  }
}

export function collectContiguousStreamParts<
  T extends StreamDelta["parts"][number],
>(
  deltas: readonly StreamDelta[],
  fromCursor = 0,
): { parts: T[]; cursor: number } {
  const parts: T[] = [];
  let cursor = fromCursor;
  for (const delta of [...deltas].sort((a, b) => a.start - b.start)) {
    if (delta.parts.length === 0) continue;
    if (cursor !== delta.start) {
      if (cursor >= delta.end) continue;
      if (cursor < delta.start) break;
      throw new Error(
        `Got unexpected delta for stream ${delta.streamId}: delta: ${delta.start} -> ${delta.end} existing cursor: ${cursor}`,
      );
    }
    parts.push(...(delta.parts as T[]));
    cursor = delta.end;
  }
  return { parts, cursor };
}

function missingPart(
  chunkType: string,
  id: string,
  partType: string,
): PersistedUIMessageChunkError {
  return new PersistedUIMessageChunkError(
    "missing-part",
    `Received ${chunkType} for missing ${partType} part with ID "${id}".`,
    chunkType,
    id,
    partType,
  );
}

function chunkRecord(value: unknown): PersistedUIMessageChunkRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid persisted UIMessageChunk");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string") {
    throw new Error("Persisted UIMessageChunk is missing a type");
  }
  return record as PersistedUIMessageChunkRecord;
}

const supportedChunkTypes = new Set([
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "custom",
  "error",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-available",
  "tool-input-error",
  "tool-approval-request",
  "tool-approval-response",
  "tool-output-available",
  "tool-output-error",
  "tool-output-denied",
  "source-url",
  "source-document",
  "file",
  "reasoning-file",
  "start-step",
  "finish-step",
  "start",
  "finish",
  "abort",
  "message-metadata",
]);

function assertSupportedPersistedUIMessageChunk(
  chunk: PersistedUIMessageChunkRecord,
): void {
  if (supportedChunkTypes.has(chunk.type) || chunk.type.startsWith("data-")) {
    return;
  }
  throw new Error(
    `persisted chunk type "${chunk.type}" is not part of the supported UIMessageChunk wire format`,
  );
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Error(`Persisted UIMessageChunk field ${field} must be a string`);
  }
  return value;
}

function booleanField(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new Error(
      `Persisted UIMessageChunk field ${field} must be a boolean`,
    );
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function providerMetadata(value: unknown): ProviderMetadata | undefined {
  return optionalRecord(value) as ProviderMetadata | undefined;
}

function isToolPart(part: PersistedUIMessagePart): part is PersistedToolPart {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}
