import type { Infer } from "convex/values";
import type { Message, MessageDoc, vToolResultOutput } from "./validators.js";

export type ToolCallApprovalDecision = {
  approvalId: string;
  approved: boolean;
  reason?: string;
};

export type ToolCallOutput = {
  toolCallId: string;
  toolName: string;
  output: Infer<typeof vToolResultOutput>;
};

// The window a batch is resolved against. Approvals and client tool calls are
// near the end of a thread, so one bounded page finds them.
export const APPROVAL_LOOKUP_MESSAGES = 100;

export function planToolCallResponses(
  messages: MessageDoc[],
  {
    decisions,
    outputs,
  }: { decisions: ToolCallApprovalDecision[]; outputs: ToolCallOutput[] },
  threadId: string,
): { requestMessageId: string; message: Extract<Message, { role: "tool" }> } {
  if (decisions.length + outputs.length === 0) {
    throw new Error("An approval batch must contain at least one decision");
  }
  const pendingApprovals = new Set(
    decisions.map(({ approvalId }) => approvalId),
  );
  if (pendingApprovals.size !== decisions.length) {
    throw new Error("Duplicate approval ids in batch");
  }
  const pendingCalls = new Set(outputs.map(({ toolCallId }) => toolCallId));
  if (pendingCalls.size !== outputs.length) {
    throw new Error("Duplicate tool call ids in batch");
  }
  let requestMessageId: string | undefined;
  const claim = (doc: MessageDoc) => {
    if (requestMessageId && requestMessageId !== doc._id) {
      throw new Error(
        "Approval decisions in one batch must belong to the same request message",
      );
    }
    requestMessageId = doc._id;
  };
  const providerExecuted = new Set<string>();
  const answeredApprovals = new Set<string>();
  const answeredCalls = new Set<string>();

  // Newest first, so a call's answers are seen before the call itself.
  for (const doc of messages) {
    if (!Array.isArray(doc.message?.content)) continue;
    const content = doc.message.content;
    for (const part of content) {
      if (part.type === "tool-approval-response") {
        answeredApprovals.add(part.approvalId);
      } else if (part.type === "tool-result") {
        answeredCalls.add(part.toolCallId);
      }
    }
    if (doc.message.role !== "assistant") continue;
    const providerCalls = new Set<string>();
    const approvalRequests = new Map<string, string>();
    for (const part of content) {
      if (part.type === "tool-call" && part.providerExecuted) {
        providerCalls.add(part.toolCallId);
      } else if (part.type === "tool-approval-request") {
        approvalRequests.set(part.toolCallId, part.approvalId);
      }
    }
    for (const part of content) {
      if (
        part.type === "tool-approval-request" &&
        pendingApprovals.has(part.approvalId)
      ) {
        if (answeredApprovals.has(part.approvalId)) {
          throw new Error(`Approval ${part.approvalId} was already handled`);
        }
        claim(doc);
        if (providerCalls.has(part.toolCallId)) {
          providerExecuted.add(part.approvalId);
        }
        pendingApprovals.delete(part.approvalId);
      } else if (
        part.type === "tool-call" &&
        pendingCalls.has(part.toolCallId)
      ) {
        const approvalId = approvalRequests.get(part.toolCallId);
        if (
          answeredCalls.has(part.toolCallId) ||
          (approvalId && answeredApprovals.has(approvalId))
        ) {
          throw new Error(`Tool call ${part.toolCallId} was already handled`);
        }
        if (approvalId) {
          throw new Error(`Tool call ${part.toolCallId} is awaiting approval`);
        }
        if (part.providerExecuted) {
          throw new Error(`Tool call ${part.toolCallId} is provider-executed`);
        }
        const { toolName } = outputs.find(
          ({ toolCallId }) => toolCallId === part.toolCallId,
        )!;
        if (part.toolName !== toolName) {
          throw new Error(
            `Tool call ${part.toolCallId} is a call to ${part.toolName}, not ${toolName}`,
          );
        }
        claim(doc);
        pendingCalls.delete(part.toolCallId);
      }
    }
    if (pendingApprovals.size === 0 && pendingCalls.size === 0) break;
  }

  if (pendingApprovals.size > 0) {
    throw new Error(
      `Approval request ${pendingApprovals.values().next().value} was not found in the last ${APPROVAL_LOOKUP_MESSAGES} messages of thread ${threadId}`,
    );
  }
  if (pendingCalls.size > 0) {
    throw new Error(
      `Tool call ${pendingCalls.values().next().value} was not found in the last ${APPROVAL_LOOKUP_MESSAGES} messages of thread ${threadId}`,
    );
  }

  return {
    requestMessageId: requestMessageId!,
    message: {
      role: "tool",
      content: [
        ...decisions.map(({ approvalId, approved, reason }) => ({
          type: "tool-approval-response" as const,
          approvalId,
          approved,
          reason,
          ...(providerExecuted.has(approvalId)
            ? { providerExecuted: true }
            : {}),
        })),
        ...outputs.map(({ toolCallId, toolName, output }) => ({
          type: "tool-result" as const,
          toolCallId,
          toolName,
          output,
        })),
      ],
    },
  };
}
