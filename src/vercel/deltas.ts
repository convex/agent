import {
  type CustomContentUIPart,
  type DynamicToolUIPart,
  type ProviderMetadata,
  type ReasoningFileUIPart,
  type ReasoningUIPart,
  type TextUIPart,
  type ToolUIPart,
  type UIMessageChunk,
} from "ai";
import { type UIMessage } from "./UIMessages.js";
import { joinText, sorted } from "../shared.js";
import {
  type MessageStatus,
  type StreamDelta,
  type StreamMessage,
} from "../validators.js";

export function blankUIMessage<METADATA = unknown>(
  streamMessage: StreamMessage & { metadata?: METADATA },
  threadId: string,
): UIMessage<METADATA> {
  return {
    id: `stream:${streamMessage.streamId}`,
    key: `${threadId}-${streamMessage.order}-${streamMessage.stepOrder}`,
    order: streamMessage.order,
    stepOrder: streamMessage.stepOrder,
    status: statusFromStreamStatus(streamMessage.status),
    agentName: streamMessage.agentName,
    text: "",
    _creationTime: Date.now(),
    role: "assistant",
    parts: [],
    ...(streamMessage.metadata ? { metadata: streamMessage.metadata } : {}),
  };
}

export function statusFromStreamStatus(
  status: StreamMessage["status"],
): MessageStatus | "streaming" {
  switch (status) {
    case "streaming":
      return "streaming";
    case "finished":
      return "success";
    case "aborted":
      return "failed";
    default:
      return "pending";
  }
}

type ToolPart = ToolUIPart | DynamicToolUIPart;

function transitionToolPart<S extends ToolPart["state"]>(
  part: ToolPart,
  updates: { state: S } & Partial<Extract<ToolPart, { state: S }>>,
): void {
  Object.assign(part, updates);
}

export type IncrementalStreamState = {
  // chunk id -> index of the streaming text part in message.parts
  activeText: Record<string, number>;
  // chunk id -> index of the streaming reasoning part in message.parts
  activeReasoning: Record<string, number>;
  // toolCallId -> raw accumulated input JSON text (kept separate from the
  // parsed `input` so partial JSON can be repair-parsed each batch)
  toolInputText: Record<string, string>;
};

export function emptyIncrementalStreamState(): IncrementalStreamState {
  return { activeText: {}, activeReasoning: {}, toolInputText: {} };
}

/**
 * Apply a batch of new UIMessageChunks to an existing UIMessage without
 * replaying prior chunks. `prev` carries the ephemeral stream state that the
 * UIMessage itself can't hold (which text/reasoning parts are still streaming,
 * and the raw accumulated tool input text). Parts are append-only, so part
 * indices stay stable across the structuredClone between batches. Behavior
 * mirrors the AI SDK's processUIMessageStream.
 */
export function applyUIMessageChunksIncremental<
  METADATA = unknown,
  DATA_PARTS extends import("ai").UIDataTypes = import("ai").UIDataTypes,
  TOOLS extends import("ai").UITools = import("ai").UITools,
>(
  uiMessage: UIMessage<METADATA, DATA_PARTS, TOOLS>,
  newParts: UIMessageChunk[],
  prev: IncrementalStreamState,
): {
  message: UIMessage<METADATA, DATA_PARTS, TOOLS>;
  streamState: IncrementalStreamState;
} {
  const message: UIMessage = structuredClone(uiMessage);
  const activeText: Record<string, number> = { ...prev.activeText };
  const activeReasoning: Record<string, number> = { ...prev.activeReasoning };
  const toolInputText: Record<string, string> = { ...prev.toolInputText };
  const touchedTools = new Set<string>();

  const toolIndexById = new Map<string, number>();
  message.parts.forEach((p, i) => {
    if (
      "toolCallId" in p &&
      (p.type.startsWith("tool-") || p.type === "dynamic-tool")
    ) {
      toolIndexById.set((p as ToolPart).toolCallId, i);
    }
  });
  const toolPartAt = (toolCallId: string): ToolPart | undefined => {
    const idx = toolIndexById.get(toolCallId);
    return idx === undefined ? undefined : (message.parts[idx] as ToolPart);
  };
  const mergeMetadata = (metadata: unknown) => {
    if (metadata == null) {
      return;
    }
    message.metadata = {
      ...(message.metadata as Record<string, unknown> | undefined),
      ...(metadata as Record<string, unknown>),
    } as typeof message.metadata;
  };

  for (const part of newParts) {
    switch (part.type) {
      case "text-start": {
        const newPart: TextUIPart = {
          type: "text",
          text: "",
          state: "streaming",
          ...(part.providerMetadata
            ? { providerMetadata: part.providerMetadata }
            : {}),
        };
        message.parts.push(newPart);
        activeText[part.id] = message.parts.length - 1;
        break;
      }
      case "text-delta": {
        const idx = activeText[part.id];
        if (idx !== undefined) {
          const textPart = message.parts[idx] as TextUIPart;
          textPart.text += part.delta;
          const providerMetadata = mergeProviderMetadata(
            textPart.providerMetadata,
            part.providerMetadata,
          );
          if (providerMetadata) textPart.providerMetadata = providerMetadata;
        }
        break;
      }
      case "text-end": {
        const idx = activeText[part.id];
        if (idx !== undefined) {
          const textPart = message.parts[idx] as TextUIPart;
          textPart.state = "done";
          if (part.citations != null) textPart.citations = part.citations;
          const providerMetadata = mergeProviderMetadata(
            textPart.providerMetadata,
            part.providerMetadata,
          );
          if (providerMetadata) textPart.providerMetadata = providerMetadata;
          delete activeText[part.id];
        }
        break;
      }
      case "reasoning-start": {
        const newPart: ReasoningUIPart = {
          type: "reasoning",
          text: "",
          state: "streaming",
          ...(part.providerMetadata
            ? { providerMetadata: part.providerMetadata }
            : {}),
        };
        message.parts.push(newPart);
        activeReasoning[part.id] = message.parts.length - 1;
        break;
      }
      case "reasoning-delta": {
        const idx = activeReasoning[part.id];
        if (idx !== undefined) {
          const reasoningPart = message.parts[idx] as ReasoningUIPart;
          reasoningPart.text += part.delta;
          const providerMetadata = mergeProviderMetadata(
            reasoningPart.providerMetadata,
            part.providerMetadata,
          );
          if (providerMetadata)
            reasoningPart.providerMetadata = providerMetadata;
        }
        break;
      }
      case "reasoning-end": {
        const idx = activeReasoning[part.id];
        if (idx !== undefined) {
          const reasoningPart = message.parts[idx] as ReasoningUIPart;
          reasoningPart.state = "done";
          const providerMetadata = mergeProviderMetadata(
            reasoningPart.providerMetadata,
            part.providerMetadata,
          );
          if (providerMetadata)
            reasoningPart.providerMetadata = providerMetadata;
          delete activeReasoning[part.id];
        }
        break;
      }
      case "reasoning-file":
        message.parts.push({
          type: "reasoning-file",
          url: part.url,
          mediaType: part.mediaType,
          ...(part.providerMetadata
            ? { providerMetadata: part.providerMetadata }
            : {}),
        } satisfies ReasoningFileUIPart);
        break;
      case "custom":
        message.parts.push({
          type: "custom",
          kind: part.kind,
          ...(part.providerMetadata
            ? { providerMetadata: part.providerMetadata }
            : {}),
        } satisfies CustomContentUIPart);
        break;
      case "tool-input-start": {
        const newToolPart: ToolUIPart | DynamicToolUIPart = part.dynamic
          ? ({
              type: "dynamic-tool",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              state: "input-streaming",
              input: undefined,
              ...(part.providerExecuted === undefined
                ? {}
                : { providerExecuted: part.providerExecuted }),
              ...(part.title === undefined ? {} : { title: part.title }),
              ...(part.toolMetadata === undefined
                ? {}
                : { toolMetadata: part.toolMetadata }),
              ...(part.providerMetadata
                ? { callProviderMetadata: part.providerMetadata }
                : {}),
            } satisfies DynamicToolUIPart)
          : ({
              type: `tool-${part.toolName}`,
              toolCallId: part.toolCallId,
              state: "input-streaming",
              input: undefined,
              ...(part.providerExecuted === undefined
                ? {}
                : { providerExecuted: part.providerExecuted }),
              ...(part.title === undefined ? {} : { title: part.title }),
              ...(part.toolMetadata === undefined
                ? {}
                : { toolMetadata: part.toolMetadata }),
              ...(part.providerMetadata
                ? { callProviderMetadata: part.providerMetadata }
                : {}),
            } satisfies ToolUIPart);
        message.parts.push(newToolPart);
        toolIndexById.set(part.toolCallId, message.parts.length - 1);
        toolInputText[part.toolCallId] = "";
        break;
      }
      case "tool-input-delta": {
        if (toolIndexById.has(part.toolCallId)) {
          toolInputText[part.toolCallId] =
            (toolInputText[part.toolCallId] ?? "") + part.inputTextDelta;
          touchedTools.add(part.toolCallId);
        } else {
          console.warn(
            `tool-input-delta for unknown toolCallId ${part.toolCallId}`,
          );
        }
        break;
      }
      case "tool-input-available": {
        let toolPart = toolPartAt(part.toolCallId);
        if (!toolPart) {
          toolPart = part.dynamic
            ? ({
                type: "dynamic-tool",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                state: "input-available",
                input: part.input,
              } satisfies DynamicToolUIPart)
            : ({
                type: `tool-${part.toolName}`,
                toolCallId: part.toolCallId,
                state: "input-available",
                input: part.input,
              } satisfies ToolUIPart);
          message.parts.push(toolPart);
          toolIndexById.set(part.toolCallId, message.parts.length - 1);
        }
        const callProviderMetadata = mergeProviderMetadata(
          (toolPart as { callProviderMetadata?: ProviderMetadata })
            .callProviderMetadata,
          part.providerMetadata,
        );
        transitionToolPart(toolPart, {
          state: "input-available",
          input: part.input,
          ...(part.providerExecuted === undefined
            ? {}
            : { providerExecuted: part.providerExecuted }),
          ...(part.title === undefined ? {} : { title: part.title }),
          ...(part.toolMetadata === undefined
            ? {}
            : { toolMetadata: part.toolMetadata }),
          ...(callProviderMetadata ? { callProviderMetadata } : {}),
        });
        touchedTools.delete(part.toolCallId);
        // The raw JSON buffer is no longer needed; drop it so it doesn't get
        // carried through every later batch on the hot path.
        delete toolInputText[part.toolCallId];
        break;
      }
      case "tool-input-error": {
        let toolPart = toolPartAt(part.toolCallId);
        if (!toolPart) {
          toolPart = part.dynamic
            ? ({
                type: "dynamic-tool",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                state: "output-error",
                input: part.input,
                errorText: part.errorText,
              } satisfies DynamicToolUIPart)
            : ({
                type: `tool-${part.toolName}`,
                toolCallId: part.toolCallId,
                state: "output-error",
                input: undefined,
                rawInput: part.input,
                errorText: part.errorText,
              } satisfies ToolUIPart);
          message.parts.push(toolPart);
          toolIndexById.set(part.toolCallId, message.parts.length - 1);
        }
        const resultProviderMetadata = mergeProviderMetadata(
          (toolPart as { resultProviderMetadata?: ProviderMetadata })
            .resultProviderMetadata,
          part.providerMetadata,
        );
        transitionToolPart(toolPart, {
          state: "output-error",
          errorText: part.errorText,
          ...(part.providerExecuted === undefined
            ? {}
            : { providerExecuted: part.providerExecuted }),
          ...(toolPart.type === "dynamic-tool"
            ? {
                input: part.input,
              }
            : {
                input: undefined,
                rawInput: part.input,
              }),
          ...(part.title === undefined ? {} : { title: part.title }),
          ...(part.toolMetadata === undefined
            ? {}
            : { toolMetadata: part.toolMetadata }),
          ...(resultProviderMetadata ? { resultProviderMetadata } : {}),
        });
        touchedTools.delete(part.toolCallId);
        delete toolInputText[part.toolCallId];
        break;
      }
      case "tool-output-available": {
        const toolPart = toolPartAt(part.toolCallId);
        if (toolPart) {
          transitionToolPart(toolPart, {
            state: "output-available",
            output: part.output,
            preliminary: part.preliminary,
            ...(part.providerExecuted === undefined
              ? {}
              : { providerExecuted: part.providerExecuted }),
            ...(part.providerMetadata
              ? { resultProviderMetadata: part.providerMetadata }
              : {}),
            ...(part.toolMetadata === undefined
              ? {}
              : { toolMetadata: part.toolMetadata }),
          });
        }
        break;
      }
      case "tool-output-error": {
        const toolPart = toolPartAt(part.toolCallId);
        if (toolPart) {
          transitionToolPart(toolPart, {
            state: "output-error",
            errorText: part.errorText,
            output: undefined,
            ...(part.providerExecuted === undefined
              ? {}
              : { providerExecuted: part.providerExecuted }),
            ...(part.providerMetadata
              ? { resultProviderMetadata: part.providerMetadata }
              : {}),
            ...(part.toolMetadata === undefined
              ? {}
              : { toolMetadata: part.toolMetadata }),
          });
          // The SDK clears a prior preliminary result when the final outcome
          // is an error. `preliminary` is not part of the error-state type.
          Object.assign(toolPart, { preliminary: undefined });
        }
        break;
      }
      case "tool-output-denied": {
        const toolPart = toolPartAt(part.toolCallId);
        if (toolPart) {
          transitionToolPart(toolPart, { state: "output-denied" });
        }
        break;
      }
      case "tool-approval-request": {
        const toolPart = toolPartAt(part.toolCallId);
        if (toolPart) {
          transitionToolPart(toolPart, {
            state: "approval-requested",
            approval: {
              id: part.approvalId,
              ...(part.isAutomatic === undefined
                ? {}
                : { isAutomatic: part.isAutomatic }),
              ...(part.signature === undefined
                ? {}
                : { signature: part.signature }),
            },
          });
        }
        break;
      }
      case "tool-approval-response": {
        const toolPart = message.parts.find(
          (candidate) =>
            "approval" in candidate &&
            (candidate as ToolPart).approval?.id === part.approvalId,
        ) as ToolPart | undefined;
        if (toolPart) {
          const callProviderMetadata = mergeProviderMetadata(
            (toolPart as { callProviderMetadata?: ProviderMetadata })
              .callProviderMetadata,
            part.providerMetadata,
          );
          transitionToolPart(toolPart, {
            state: "approval-responded",
            approval: {
              ...toolPart.approval,
              id: part.approvalId,
              approved: part.approved,
              ...(part.reason === undefined ? {} : { reason: part.reason }),
            },
            ...(part.providerExecuted === undefined
              ? {}
              : { providerExecuted: part.providerExecuted }),
            ...(callProviderMetadata ? { callProviderMetadata } : {}),
          });
        }
        break;
      }
      case "source-url":
        message.parts.push({
          type: "source-url",
          url: part.url,
          sourceId: part.sourceId,
          title: part.title,
          providerMetadata: part.providerMetadata,
        });
        break;
      case "source-document":
        message.parts.push({
          type: "source-document",
          mediaType: part.mediaType,
          sourceId: part.sourceId,
          title: part.title,
          filename: part.filename,
          providerMetadata: part.providerMetadata,
        });
        break;
      case "file":
        message.parts.push({
          type: "file",
          mediaType: part.mediaType,
          url: part.url,
          providerMetadata: part.providerMetadata,
        });
        break;
      case "start-step":
        message.parts.push({ type: "step-start" });
        break;
      case "finish-step":
        // Match the SDK: a new step starts fresh streaming parts; the prior
        // parts keep their state rather than being forced to "done".
        for (const id of Object.keys(activeText)) delete activeText[id];
        for (const id of Object.keys(activeReasoning))
          delete activeReasoning[id];
        break;
      case "start":
      case "finish":
      case "message-metadata":
        mergeMetadata(part.messageMetadata);
        break;
      case "abort":
      case "error":
        // The stream-level status (statusFromStreamStatus) is authoritative and
        // is applied by the caller; nothing to mutate on the message here.
        break;
      default: {
        if (typeof part.type === "string" && part.type.startsWith("data-")) {
          const dataPart = part as Extract<
            UIMessageChunk,
            { type: `data-${string}` }
          >;
          const existingIdx =
            dataPart.id != null
              ? message.parts.findIndex(
                  (p) =>
                    p.type === dataPart.type &&
                    (p as { id?: string }).id === dataPart.id,
                )
              : -1;
          if (dataPart.transient) {
            break;
          }
          if (existingIdx >= 0) {
            (message.parts[existingIdx] as { data?: unknown }).data =
              dataPart.data;
          } else {
            message.parts.push(
              dataPart as unknown as UIMessage["parts"][number],
            );
          }
        } else {
          console.warn(
            `applyUIMessageChunksIncremental: unhandled chunk type ${String(part.type)}`,
          );
        }
        break;
      }
    }
  }

  for (const toolCallId of touchedTools) {
    const toolPart = toolPartAt(toolCallId);
    if (toolPart && toolPart.state === "input-streaming") {
      try {
        toolPart.input = JSON.parse(toolInputText[toolCallId] ?? "");
      } catch {
        // partial JSON — leave input unset until complete
      }
    }
  }

  message.text = joinText(message.parts);
  return {
    message: message as UIMessage<METADATA, DATA_PARTS, TOOLS>,
    streamState: { activeText, activeReasoning, toolInputText },
  };
}

export async function deriveUIMessagesFromDeltas(
  threadId: string,
  streamMessages: StreamMessage[],
  allDeltas: StreamDelta[],
): Promise<UIMessage[]> {
  const messages: UIMessage[] = [];
  for (const streamMessage of streamMessages) {
    if (streamMessage.format !== "UIMessageChunk") {
      throw new Error(
        `deriveUIMessagesFromDeltas: unsupported stream format "${streamMessage.format ?? "text"}" for stream ${streamMessage.streamId}`,
      );
    }
    const { parts } = getParts<UIMessageChunk>(
      allDeltas.filter((d) => d.streamId === streamMessage.streamId),
      0,
    );
    const uiMessage = applyUIMessageChunksIncremental(
      blankUIMessage(streamMessage, threadId),
      parts,
      emptyIncrementalStreamState(),
    ).message;
    messages.push(uiMessage);
  }
  return sorted(messages);
}

export function getParts<T extends StreamDelta["parts"][number]>(
  deltas: StreamDelta[],
  fromCursor?: number,
): { parts: T[]; cursor: number } {
  const parts: T[] = [];
  let cursor = fromCursor ?? 0;
  for (const delta of deltas.sort((a, b) => a.start - b.start)) {
    if (delta.parts.length === 0) {
      console.debug(`Got delta with no parts: ${JSON.stringify(delta)}`);
      continue;
    }
    if (cursor !== delta.start) {
      if (cursor >= delta.end) {
        continue;
      } else if (cursor < delta.start) {
        console.warn(
          `Got delta for stream ${delta.streamId} that has a gap ${cursor} -> ${delta.start}`,
        );
        break;
      } else {
        throw new Error(
          `Got unexpected delta for stream ${delta.streamId}: delta: ${delta.start} -> ${delta.end} existing cursor: ${cursor}`,
        );
      }
    }
    parts.push(...delta.parts);
    cursor = delta.end;
  }
  return { parts, cursor };
}

function mergeProviderMetadata(
  existing: ProviderMetadata | undefined,
  part: ProviderMetadata | undefined,
): ProviderMetadata | undefined {
  return part ?? existing;
}
