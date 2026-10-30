import {
  convertToModelMessages,
  type UIMessage as AIUIMessage,
  type CustomContentUIPart,
  type DeepPartial,
  type DynamicToolUIPart,
  type ReasoningFileUIPart,
  type ReasoningUIPart,
  type SourceDocumentUIPart,
  type SourceUrlUIPart,
  type StepStartUIPart,
  type TextUIPart,
  type ToolResultPart,
  type ToolUIPart,
  type UIDataTypes,
  type UITools,
} from "ai";
import {
  convertUint8ArrayToBase64,
  type ReasoningFilePart,
} from "@ai-sdk/provider-utils";
import type { Infer } from "convex/values";
import { toModelMessage, fromModelMessage, toUIFilePart } from "./mapping.js";
import {
  extractReasoning,
  extractText,
  isTool,
  joinText,
  sorted,
} from "../shared.js";
import type {
  MessageDoc,
  MessageStatus,
  ProviderOptions,
  SourcePart,
  vSource,
} from "../validators.js";
import { omit, pick } from "convex-helpers";

export type UIStatus = "streaming" | MessageStatus;

export type UIMessage<
  METADATA = unknown,
  DATA_PARTS extends UIDataTypes = UIDataTypes,
  TOOLS extends UITools = UITools,
> = AIUIMessage<METADATA, DATA_PARTS, TOOLS> & {
  key: string;
  order: number;
  stepOrder: number;
  status: UIStatus;
  agentName?: string;
  userId?: string;
  text: string;
  _creationTime: number;
};

/**
 * Converts a list of UIMessages to MessageDocs, along with extra metadata that
 * may be available to associate with the MessageDocs.
 * @param messages - The UIMessages to convert to MessageDocs.
 * @param meta - The metadata to add to the MessageDocs.
 * @returns
 */
export async function fromUIMessages<METADATA = unknown>(
  messages: UIMessage<METADATA>[],
  meta: {
    threadId: string;
    userId?: string;
    model?: string;
    provider?: string;
    providerOptions?: ProviderOptions;
    metadata?: METADATA;
  },
): Promise<(MessageDoc & { streaming: boolean; metadata?: METADATA })[]> {
  const nested = await Promise.all(
    messages.map(async (uiMessage) => {
      const stepOrder = uiMessage.stepOrder;
      const commonFields = {
        ...pick(meta, [
          "threadId",
          "userId",
          "model",
          "provider",
          "providerOptions",
          "metadata",
        ]),
        ...omit(uiMessage, ["parts", "role", "key", "text", "userId"]),
        userId: uiMessage.userId ?? meta.userId,
        status: uiMessage.status === "streaming" ? "pending" : "success",
        streaming: uiMessage.status === "streaming",
        // to override
        _id: uiMessage.id,
        tool: false,
      } satisfies MessageDoc & { streaming: boolean; metadata?: METADATA };
      const modelMessages = await convertToModelMessages([uiMessage]);
      return modelMessages
        .map((modelMessage, i) => {
          if (modelMessage.content.length === 0) {
            return undefined;
          }
          const message = fromModelMessage(modelMessage);
          const tool = isTool(message);
          const doc: MessageDoc & { streaming: boolean; metadata?: METADATA } =
            {
              ...commonFields,
              _id: uiMessage.id + `-${i}`,
              stepOrder: stepOrder + i,
              message,
              tool,
              text: extractText(message),
              reasoning: extractReasoning(message),
              finishReason: tool ? "tool-calls" : "stop",
              sources: fromSourceParts(uiMessage.parts),
            };
          if (Array.isArray(modelMessage.content)) {
            // Find a content part with providerOptions (type assertion needed for SDK compatibility)
            const partWithProviderOptions = modelMessage.content.find(
              (c): c is typeof c & { providerOptions: unknown } =>
                "providerOptions" in c && c.providerOptions !== undefined,
            );
            if (partWithProviderOptions?.providerOptions) {
              // convertToModelMessages changes providerMetadata to providerOptions
              const providerOptions =
                partWithProviderOptions.providerOptions as
                  | Record<string, Record<string, unknown>>
                  | undefined;
              if (providerOptions) {
                doc.providerMetadata = providerOptions;
                doc.providerOptions ??= providerOptions;
              }
            }
          }
          return doc;
        })
        .filter((d) => d !== undefined);
    }),
  );
  return nested.flat();
}

function fromSourceParts(parts: UIMessage["parts"]): Infer<typeof vSource>[] {
  return parts
    .map((part) => {
      if (part.type === "source-url") {
        return {
          type: "source",
          sourceType: "url",
          url: part.url,
          id: part.sourceId,
          providerMetadata: part.providerMetadata,
          title: part.title,
        } satisfies Infer<typeof vSource>;
      }
      if (part.type === "source-document") {
        return {
          type: "source",
          sourceType: "document",
          mediaType: part.mediaType,
          id: part.sourceId,
          providerMetadata: part.providerMetadata,
          title: part.title,
          filename: part.filename,
        } satisfies Infer<typeof vSource>;
      }
      return undefined;
    })
    .filter((p) => p !== undefined);
}

type ExtraFields<METADATA = unknown> = {
  streaming?: boolean;
  metadata?: METADATA;
};

/**
 * Converts a list of MessageDocs to UIMessages.
 * This is somewhat lossy, as many fields are not supported by UIMessages, e.g.
 * the model, provider, userId, etc.
 * The UIMessage type is the augmented type that includes more fields such as
 * key, order, stepOrder, status, agentName, text, etc.
 */
export function toUIMessages<
  METADATA = unknown,
  DATA_PARTS extends UIDataTypes = UIDataTypes,
  TOOLS extends UITools = UITools,
>(
  messages: (MessageDoc & ExtraFields<METADATA>)[],
): UIMessage<METADATA, DATA_PARTS, TOOLS>[] {
  // Group assistant and tool messages together
  const assistantGroups = groupAssistantMessages(sorted(messages));

  const uiMessages: UIMessage<METADATA, DATA_PARTS, TOOLS>[] = [];
  for (const group of assistantGroups) {
    if (group.role === "system") {
      uiMessages.push(createSystemUIMessage(group.message));
    } else if (group.role === "user") {
      uiMessages.push(createUserUIMessage(group.message));
    } else {
      // Assistant/tool group
      uiMessages.push(createAssistantUIMessage(group.messages));
    }
  }

  return uiMessages;
}

type Group<METADATA = unknown> =
  | {
      role: "user";
      message: MessageDoc & ExtraFields<METADATA>;
    }
  | {
      role: "system";
      message: MessageDoc & ExtraFields<METADATA>;
    }
  | {
      role: "assistant";
      messages: (MessageDoc & ExtraFields<METADATA>)[];
    };

function groupAssistantMessages<METADATA = unknown>(
  messages: (MessageDoc & ExtraFields<METADATA>)[],
): Group<METADATA>[] {
  const groups: Group<METADATA>[] = [];

  let currentAssistantGroup: (MessageDoc & ExtraFields<METADATA>)[] = [];
  let currentOrder: number | undefined;

  for (const message of messages) {
    const coreMessage = message.message && toModelMessage(message.message);
    if (!coreMessage) continue;

    if (coreMessage.role === "user" || coreMessage.role === "system") {
      // Finish any current assistant group
      if (currentAssistantGroup.length > 0) {
        groups.push({
          role: "assistant",
          messages: currentAssistantGroup,
        });
        currentAssistantGroup = [];
        currentOrder = undefined;
      }
      // Add singleton group
      groups.push({
        role: coreMessage.role,
        message,
      });
    } else {
      // Assistant or tool message

      // Start new group if order changes or this is the first assistant/tool message
      if (currentOrder !== undefined && message.order !== currentOrder) {
        if (currentAssistantGroup.length > 0) {
          groups.push({
            role: "assistant",
            messages: currentAssistantGroup,
          });
          currentAssistantGroup = [];
        }
      }

      currentOrder = message.order;
      currentAssistantGroup.push(message);

      // End group if this is an assistant message without tool calls
      if (coreMessage.role === "assistant" && !message.tool) {
        groups.push({
          role: "assistant",
          messages: currentAssistantGroup,
        });
        currentAssistantGroup = [];
        currentOrder = undefined;
      }
    }
  }

  // Add any remaining assistant group
  if (currentAssistantGroup.length > 0) {
    groups.push({
      role: "assistant",
      messages: currentAssistantGroup,
    });
  }

  return groups;
}

function createSystemUIMessage<
  METADATA = unknown,
  DATA_PARTS extends UIDataTypes = UIDataTypes,
  TOOLS extends UITools = UITools,
>(
  message: MessageDoc & ExtraFields<METADATA>,
): UIMessage<METADATA, DATA_PARTS, TOOLS> {
  const text = extractTextFromMessageDoc(message);
  const partCommon = {
    state: message.streaming ? ("streaming" as const) : ("done" as const),
    ...(message.providerMetadata
      ? { providerMetadata: message.providerMetadata }
      : {}),
  };

  return {
    id: message._id,
    _creationTime: message._creationTime,
    order: message.order,
    stepOrder: message.stepOrder,
    status: message.streaming ? ("streaming" as const) : message.status,
    key: `${message.threadId}-${message.order}-${message.stepOrder}`,
    text,
    role: "system",
    agentName: message.agentName,
    userId: message.userId,
    parts: [{ type: "text", text, ...partCommon } satisfies TextUIPart],
    metadata: message.metadata,
  };
}

function extractTextFromMessageDoc(message: MessageDoc): string {
  return (
    (message.message && extractText(message.message)) || message.text || ""
  );
}

function createUserUIMessage<
  METADATA = unknown,
  DATA_PARTS extends UIDataTypes = UIDataTypes,
  TOOLS extends UITools = UITools,
>(
  message: MessageDoc & ExtraFields<METADATA>,
): UIMessage<METADATA, DATA_PARTS, TOOLS> {
  const text = extractTextFromMessageDoc(message);
  const coreMessage = toModelMessage(message.message!);
  const content = coreMessage.content;
  const nonStringContent =
    content && typeof content !== "string" ? content : [];

  const partCommon = {
    state: message.streaming ? ("streaming" as const) : ("done" as const),
    ...(message.providerMetadata
      ? { providerMetadata: message.providerMetadata }
      : {}),
  };

  const parts: UIMessage<METADATA, DATA_PARTS, TOOLS>["parts"] = [];
  if (text && !nonStringContent.length) {
    parts.push({ type: "text", text, ...partCommon });
  }
  for (const contentPart of nonStringContent) {
    switch (contentPart.type) {
      case "text":
        parts.push({ type: "text", text: contentPart.text, ...partCommon });
        break;
      case "file":
      case "image":
        parts.push(toUIFilePart(contentPart));
        break;
      default:
        console.warn("Unknown content part type for user", contentPart);
        break;
    }
  }

  return {
    id: message._id,
    _creationTime: message._creationTime,
    order: message.order,
    stepOrder: message.stepOrder,
    status: message.streaming ? ("streaming" as const) : message.status,
    key: `${message.threadId}-${message.order}-${message.stepOrder}`,
    text,
    role: "user",
    userId: message.userId,
    parts,
    metadata: message.metadata,
  };
}

function createAssistantUIMessage<
  METADATA = unknown,
  DATA_PARTS extends UIDataTypes = UIDataTypes,
  TOOLS extends UITools = UITools,
>(
  groupUnordered: (MessageDoc & ExtraFields<METADATA>)[],
): UIMessage<METADATA, DATA_PARTS, TOOLS> {
  const group = sorted(groupUnordered);
  const firstMessage = group[0];

  // Use first message for special fields
  const common = {
    id: firstMessage._id,
    _creationTime: firstMessage._creationTime,
    order: firstMessage.order,
    stepOrder: firstMessage.stepOrder,
    key: `${firstMessage.threadId}-${firstMessage.order}-${firstMessage.stepOrder}`,
    agentName: firstMessage.agentName,
    userId: firstMessage.userId,
  };

  // Get status from last message
  const lastMessage = group[group.length - 1];
  const status = lastMessage.streaming
    ? ("streaming" as const)
    : lastMessage.status;

  // Extract approval parts from raw message content for UI rendering
  type ApprovalPart =
    | {
        type: "tool-approval-request";
        approvalId: string;
        toolCallId: string;
        isAutomatic?: boolean;
        signature?: string;
      }
    | {
        type: "tool-approval-response";
        approvalId: string;
        approved: boolean;
        reason?: string;
      };
  const approvalParts: ApprovalPart[] = [];

  // Extract execution-denied tool results from raw content for UI rendering
  // (these are converted to text format for provider compatibility in start.ts)
  type ExecutionDeniedInfo = {
    toolCallId: string;
    reason?: string;
  };
  const executionDeniedResults: ExecutionDeniedInfo[] = [];

  for (const message of group) {
    const rawContent = message.message?.content;
    if (Array.isArray(rawContent)) {
      for (const part of rawContent) {
        if (
          part.type === "tool-approval-request" ||
          part.type === "tool-approval-response"
        ) {
          approvalParts.push(part as ApprovalPart);
        }
        // Check for execution-denied in tool-result outputs
        if (
          part.type === "tool-result" &&
          typeof part.output === "object" &&
          part.output !== null &&
          (part.output as { type?: string }).type === "execution-denied"
        ) {
          executionDeniedResults.push({
            toolCallId: part.toolCallId as string,
            reason: (part.output as { reason?: string }).reason,
          });
        }
      }
    }
  }

  // Collect all parts from all messages
  const allParts: UIMessage<METADATA, DATA_PARTS, TOOLS>["parts"] = [];

  for (const message of group) {
    const coreMessage = message.message && toModelMessage(message.message);
    if (!coreMessage) continue;

    const content = coreMessage.content;
    const nonStringContent =
      content && typeof content !== "string" ? content : [];
    const text = extractTextFromMessageDoc(message);

    const partCommon = {
      state: message.streaming ? ("streaming" as const) : ("done" as const),
      ...(message.providerMetadata
        ? { providerMetadata: message.providerMetadata }
        : {}),
    };

    // Add reasoning parts
    if (
      message.reasoning &&
      !nonStringContent.some((c) => c.type === "reasoning")
    ) {
      allParts.push({
        type: "reasoning",
        text: message.reasoning,
        ...partCommon,
      } satisfies ReasoningUIPart);
    }

    // Add text parts if no structured content
    if (text && !nonStringContent.length) {
      allParts.push({
        type: "text",
        text: text,
        ...partCommon,
      } satisfies TextUIPart);
    }

    // Add all structured content parts
    for (const contentPart of nonStringContent) {
      switch (contentPart.type) {
        case "text":
          allParts.push({
            ...partCommon,
            ...contentPart,
          } satisfies TextUIPart);
          break;
        case "reasoning":
          allParts.push({
            ...partCommon,
            ...contentPart,
          } satisfies ReasoningUIPart);
          break;
        case "reasoning-file":
          allParts.push(toUIReasoningFilePart(contentPart));
          break;
        case "custom":
          allParts.push({
            type: "custom",
            kind: contentPart.kind,
            providerMetadata: contentPart.providerOptions,
          } satisfies CustomContentUIPart);
          break;
        case "file":
        case "image":
          allParts.push(toUIFilePart(contentPart));
          break;
        case "tool-call": {
          allParts.push({
            type: "step-start",
          } satisfies StepStartUIPart);
          const toolPart: ToolUIPart<TOOLS> = {
            type: `tool-${contentPart.toolName as keyof TOOLS & string}`,
            toolCallId: contentPart.toolCallId,
            input: contentPart.input as DeepPartial<
              TOOLS[keyof TOOLS & string]["input"]
            >,
            providerExecuted: contentPart.providerExecuted,
            ...(message.streaming
              ? { state: "input-streaming" }
              : {
                  state: "input-available",
                  callProviderMetadata: message.providerMetadata,
                }),
          };
          allParts.push(toolPart);
          break;
        }
        case "tool-result": {
          // Note: execution-denied outputs are handled separately via pre-extraction
          // from raw content (converted to text format for providers in start.ts).
          // See executionDeniedResults processing at the end of this function.
          const typedPart = contentPart as unknown as ToolResultPart & {
            output: { type: string; value?: unknown; reason?: string };
          };

          // Check if this is an execution-denied result
          if (typedPart.output?.type === "execution-denied") {
            const call = allParts.find(
              (part) =>
                part.type === `tool-${contentPart.toolName}` &&
                "toolCallId" in part &&
                part.toolCallId === contentPart.toolCallId,
            ) as ToolUIPart | undefined;

            if (call) {
              call.state = "output-denied";
              if (!("approval" in call) || !call.approval) {
                (call as ToolUIPart & { approval?: object }).approval = {
                  id: "",
                  approved: false,
                  reason: typedPart.output.reason,
                };
              } else {
                const approval = (
                  call as ToolUIPart & {
                    approval: { approved?: boolean; reason?: string };
                  }
                ).approval;
                approval.approved = false;
                approval.reason = typedPart.output.reason;
              }
            }
            break;
          }

          const output =
            typeof typedPart.output?.type === "string"
              ? typedPart.output.value
              : typedPart.output;
          // Check for error at both the content part level (isError) and message level
          // isError may exist on stored tool results but isn't in ToolResultPart type
          const outputType = typedPart.output?.type;
          const hasError =
            (contentPart as { isError?: boolean }).isError ||
            message.error ||
            outputType === "error-text" ||
            outputType === "error-json";
          const errorText =
            message.error ||
            (hasError
              ? outputType === "error-json"
                ? JSON.stringify(output)
                : String(output)
              : undefined);
          const call = allParts.find(
            (part) =>
              part.type === `tool-${contentPart.toolName}` &&
              "toolCallId" in part &&
              part.toolCallId === contentPart.toolCallId,
          ) as ToolUIPart | undefined;
          if (call) {
            if (hasError) {
              call.state = "output-error";
              call.errorText = errorText ?? "Unknown error";
              call.output = output;
            } else {
              call.state = "output-available";
              call.output = output;
            }
          } else {
            // Tool call is on a previous page - create standalone tool part
            if (hasError) {
              allParts.push({
                type: `tool-${contentPart.toolName}`,
                toolCallId: contentPart.toolCallId,
                state: "output-error",
                input: undefined,
                errorText: errorText ?? "Unknown error",
                callProviderMetadata: message.providerMetadata,
              } satisfies ToolUIPart<TOOLS>);
            } else {
              allParts.push({
                type: `tool-${contentPart.toolName}`,
                toolCallId: contentPart.toolCallId,
                state: "output-available",
                input: undefined,
                output,
                callProviderMetadata: message.providerMetadata,
              } satisfies ToolUIPart<TOOLS>);
            }
          }
          break;
        }
        case "tool-approval-request": {
          // Find the matching tool call
          const typedPart = contentPart as {
            toolCallId: string;
            approvalId: string;
            isAutomatic?: boolean;
            signature?: string;
          };
          const toolCallPart = allParts.find(
            (part) =>
              "toolCallId" in part && part.toolCallId === typedPart.toolCallId,
          ) as ToolUIPart | undefined;

          if (toolCallPart) {
            toolCallPart.state = "approval-requested";
            (toolCallPart as ToolUIPart & { approval?: object }).approval = {
              id: typedPart.approvalId,
              ...(typedPart.isAutomatic !== undefined
                ? { isAutomatic: typedPart.isAutomatic }
                : {}),
              ...(typedPart.signature !== undefined
                ? { signature: typedPart.signature }
                : {}),
            };
          } else {
            console.warn(
              "Tool approval request without preceding tool call",
              contentPart,
            );
          }
          break;
        }
        case "tool-approval-response": {
          // Find the tool call that has this approval by matching approval.id
          const typedPart = contentPart as {
            approvalId: string;
            approved: boolean;
            reason?: string;
          };
          const toolCallPart = allParts.find(
            (part) =>
              "approval" in part &&
              (part as ToolUIPart & { approval?: { id: string } }).approval
                ?.id === typedPart.approvalId,
          ) as ToolUIPart | undefined;

          if (toolCallPart) {
            const approval = (
              toolCallPart as ToolUIPart & {
                approval?: { isAutomatic?: boolean; signature?: string };
              }
            ).approval;
            if (typedPart.approved) {
              toolCallPart.state = "approval-responded";
              (toolCallPart as ToolUIPart & { approval?: object }).approval = {
                ...approval,
                id: typedPart.approvalId,
                approved: true,
                reason: typedPart.reason,
              };
            } else {
              toolCallPart.state = "output-denied";
              (toolCallPart as ToolUIPart & { approval?: object }).approval = {
                ...approval,
                id: typedPart.approvalId,
                approved: false,
                reason: typedPart.reason,
              };
            }
          } else {
            console.warn(
              "Tool approval response without matching approval request",
              contentPart,
            );
          }
          break;
        }
        default: {
          const maybeSource = contentPart as unknown as SourcePart;
          if (maybeSource.type === "source") {
            allParts.push(toSourcePart(maybeSource));
          } else {
            console.warn(
              "Unknown content part type for assistant",
              contentPart,
            );
          }
        }
      }
    }

    // Add source parts
    for (const source of message.sources ?? []) {
      allParts.push(toSourcePart(source));
    }
  }

  // Final output states that should not be overwritten by approval processing
  const finalStates = new Set([
    "output-available",
    "output-error",
    "output-denied",
  ]);

  // Process approval parts to update tool call states
  for (const approvalPart of approvalParts) {
    if (approvalPart.type === "tool-approval-request") {
      const toolCallPart = allParts.find(
        (part) =>
          "toolCallId" in part && part.toolCallId === approvalPart.toolCallId,
      ) as ToolUIPart | undefined;

      if (toolCallPart) {
        // Always set approval info (needed for response matching), but only
        // update state if not in a final state
        (toolCallPart as ToolUIPart & { approval?: object }).approval = {
          id: approvalPart.approvalId,
          ...(approvalPart.isAutomatic !== undefined
            ? { isAutomatic: approvalPart.isAutomatic }
            : {}),
          ...(approvalPart.signature !== undefined
            ? { signature: approvalPart.signature }
            : {}),
        };
        if (!finalStates.has(toolCallPart.state)) {
          toolCallPart.state = "approval-requested";
        }
      }
    } else if (approvalPart.type === "tool-approval-response") {
      const toolCallPart = allParts.find(
        (part) =>
          "approval" in part &&
          (part as ToolUIPart & { approval?: { id: string } }).approval?.id ===
            approvalPart.approvalId,
      ) as ToolUIPart | undefined;

      if (toolCallPart) {
        // Always update approval info, but only update state if not in a final state
        const approval = (
          toolCallPart as ToolUIPart & {
            approval?: { isAutomatic?: boolean; signature?: string };
          }
        ).approval;
        (toolCallPart as ToolUIPart & { approval?: object }).approval = {
          ...approval,
          id: approvalPart.approvalId,
          approved: approvalPart.approved,
          reason: approvalPart.reason,
        };
        if (!finalStates.has(toolCallPart.state)) {
          if (approvalPart.approved) {
            toolCallPart.state = "approval-responded";
          } else {
            toolCallPart.state = "output-denied";
          }
        }
      }
    }
  }

  // Process execution-denied results to update tool call states
  for (const denied of executionDeniedResults) {
    const toolCallPart = allParts.find(
      (part) => "toolCallId" in part && part.toolCallId === denied.toolCallId,
    ) as ToolUIPart | undefined;

    if (toolCallPart) {
      toolCallPart.state = "output-denied";
      if (!("approval" in toolCallPart) || !toolCallPart.approval) {
        (toolCallPart as ToolUIPart & { approval?: object }).approval = {
          id: "",
          approved: false,
          reason: denied.reason,
        };
      } else {
        const approval = (
          toolCallPart as ToolUIPart & {
            approval: { approved?: boolean; reason?: string };
          }
        ).approval;
        approval.approved = false;
        approval.reason = denied.reason;
      }
    }
  }

  return {
    ...common,
    role: "assistant",
    text: joinText(allParts),
    status,
    parts: allParts,
    metadata: group.find((m) => m.metadata)?.metadata,
  };
}

function toUIReasoningFilePart(part: ReasoningFilePart): ReasoningFileUIPart {
  const data = part.data;
  return {
    type: "reasoning-file",
    mediaType: part.mediaType,
    url: toUIReasoningFileUrl(data, part.mediaType),
    providerMetadata: part.providerOptions,
  };
}

function toUIReasoningFileUrl(
  data: ReasoningFilePart["data"],
  mediaType: string,
): string {
  if (isTaggedReasoningFileData(data)) {
    if (data.type === "url") return data.url.toString();
    data = data.data;
  }
  if (data instanceof URL) return data.toString();
  if (typeof data === "string") {
    return data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
  }
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return `data:${mediaType};base64,${convertUint8ArrayToBase64(bytes)}`;
}

function isTaggedReasoningFileData(
  data: ReasoningFilePart["data"],
): data is Extract<ReasoningFilePart["data"], { type: string }> {
  return (
    typeof data === "object" &&
    data !== null &&
    !(data instanceof URL) &&
    !(data instanceof ArrayBuffer) &&
    !(data instanceof Uint8Array) &&
    "type" in data
  );
}

function toSourcePart(
  part: SourcePart | Infer<typeof vSource>,
): SourceUrlUIPart | SourceDocumentUIPart {
  if (part.sourceType === "url") {
    return {
      type: "source-url",
      url: part.url,
      sourceId: part.id,
      providerMetadata: part.providerMetadata,
      title: part.title,
    } satisfies SourceUrlUIPart;
  }
  return {
    type: "source-document",
    mediaType: part.mediaType,
    sourceId: part.id,
    title: part.title,
    filename: part.filename,
    providerMetadata: part.providerMetadata,
  } satisfies SourceDocumentUIPart;
}

export function combineUIMessages(messages: UIMessage[]): UIMessage[] {
  const combined = messages.reduce((acc, message) => {
    if (!acc.length) {
      return [message];
    }
    const previous = acc.at(-1)!;
    if (
      message.order !== previous.order ||
      previous.role !== message.role ||
      message.role !== "assistant"
    ) {
      acc.push(message);
      return acc;
    }
    // We will replace it with a combined message
    acc.pop();
    const newParts = [...previous.parts];
    for (const part of message.parts) {
      const toolCallId = getToolCallId(part);
      if (!toolCallId) {
        newParts.push(part);
        continue;
      }
      const previousPartIndex = newParts.findIndex(
        (p) => getToolCallId(p) === toolCallId,
      );
      if (previousPartIndex === -1) {
        // Tool call not found in previous parts, add it as new
        newParts.push(part);
        continue;
      }
      newParts[previousPartIndex] = mergeParts(
        newParts[previousPartIndex],
        part,
      );
    }
    acc.push({
      ...previous,
      ...pick(message, ["status", "metadata", "agentName"]),
      parts: newParts,
      text: joinText(newParts),
    });
    return acc;
  }, [] as UIMessage[]);
  return combined;
}

function getToolCallId(
  part: UIMessage["parts"][number] & { toolCallId?: string },
) {
  return part.toolCallId;
}

function mergeParts(
  previousPart: UIMessage["parts"][number],
  part: UIMessage["parts"][number],
): UIMessage["parts"][number] {
  const merged: Record<string, unknown> = { ...previousPart };
  for (const [key, value] of Object.entries(part)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as ToolUIPart | DynamicToolUIPart;
}
