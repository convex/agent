import type { MessageStatus, ThreadMessageLike } from "@assistant-ui/react";
import type { UIMessage } from "@convex-dev/agent/react";
import {
  getToolName,
  isDataUIPart,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
} from "ai";

type Part = Exclude<ThreadMessageLike["content"], string>[number];

export function convertMessage(message: UIMessage): ThreadMessageLike {
  return {
    // Convex's key survives the transition from streamed to persisted messages.
    id: message.key,
    role: message.role,
    createdAt: new Date(message._creationTime),
    content: message.parts.flatMap(convertPart),
    ...(message.role === "assistant" ? { status: convertStatus(message) } : {}),
  };
}

export function pendingApprovalIds(message: UIMessage | undefined) {
  return (message?.parts ?? []).flatMap((part) =>
    isToolUIPart(part) && part.state === "approval-requested"
      ? [part.approval.id]
      : [],
  );
}

function convertStatus(message: UIMessage): MessageStatus {
  switch (message.status) {
    case "pending":
    case "streaming":
      return { type: "running" };
    case "failed":
      return { type: "incomplete", reason: "error" };
    case "success":
      return pendingApprovalIds(message).length
        ? { type: "requires-action", reason: "tool-calls" }
        : { type: "complete", reason: "stop" };
  }
}

function convertPart(part: UIMessage["parts"][number]): Part[] {
  switch (part.type) {
    case "text":
    case "reasoning":
      return [{ type: part.type, text: part.text }];
    case "dynamic-tool":
      return [convertToolPart(part)];
    case "source-url":
      return [
        {
          type: "source",
          sourceType: "url",
          id: part.sourceId,
          url: part.url,
          title: part.title,
        },
      ];
    case "source-document":
      return [
        {
          type: "source",
          sourceType: "document",
          id: part.sourceId,
          title: part.title,
          mediaType: part.mediaType,
          filename: part.filename,
        },
      ];
    case "file":
      return [
        part.mediaType.startsWith("image")
          ? { type: "image", image: part.url, filename: part.filename }
          : {
              type: "file",
              data: part.url,
              mimeType: part.mediaType,
              filename: part.filename,
            },
      ];
    // assistant-ui has no equivalent for these.
    case "step-start":
    case "custom":
    case "reasoning-file":
      return [];
    default:
      if (isToolUIPart(part)) return [convertToolPart(part)];
      if (isDataUIPart(part)) return [{ type: part.type, data: part.data }];
      return part satisfies never;
  }
}

function convertToolPart(part: ToolUIPart | DynamicToolUIPart): Part {
  const call = {
    type: "tool-call",
    toolCallId: part.toolCallId,
    toolName: getToolName(part),
    argsText: JSON.stringify(part.input ?? {}),
  } as const;
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      return call;
    case "approval-requested":
    case "approval-responded":
      return { ...call, approval: part.approval };
    case "output-available":
      return { ...call, approval: part.approval, result: part.output };
    case "output-error":
      return {
        ...call,
        approval: part.approval,
        result: part.errorText,
        isError: true,
      };
    case "output-denied":
      return {
        ...call,
        approval: part.approval,
        result: { error: part.approval.reason ?? "Tool approval denied" },
        isError: true,
      };
  }
}
