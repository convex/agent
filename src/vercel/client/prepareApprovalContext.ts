import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";
import type { Message, MessageDoc } from "../../validators.js";
import { toModelMessage } from "../mapping.js";

type Part =
  | Exclude<AssistantModelMessage["content"], string>[number]
  | ToolModelMessage["content"][number];
type Call = Extract<Part, { type: "tool-call" }>;
type Result = Extract<Part, { type: "tool-result" }>;
type StoredPart = Exclude<Message["content"], string>[number];
type Stored<T extends StoredPart["type"]> = Extract<StoredPart, { type: T }>;

export type ApprovalPlan = {
  callIds: Set<string>;
  // Stored denials of local calls with no result, by approval.
  denials: Map<string, string | undefined>;
  continuedCallIds: Set<string>;
  continuedProviderApprovalIds: string[];
  continuation: ModelMessage[];
};

// Planned before the context handler runs, since the messages it is given
// share nested objects with these docs.
export function planApprovals({
  docs,
  recorded,
  continued,
  inline,
}: {
  docs: MessageDoc[];
  // The continuedApprovalIds of the fetched messages.
  recorded: string[];
  continued: ReadonlySet<string> | undefined;
  // The caller's messages and prompt.
  inline: (ModelMessage | Message)[];
}): ApprovalPlan {
  type Request = Stored<"tool-approval-request"> & {
    call: Stored<"tool-call"> | undefined;
  };
  const requests = new Map<string, Request[]>();
  const decisions = new Map<string, Stored<"tool-approval-response">>();
  // A result settles the requests for its call id made before it. A
  // provider-owned approval does not always produce one, so a continuation
  // records the provider-owned approvals it continued on its first message.
  const unanswered = new Map<string, string[]>();
  const answered = new Set<string>();
  const ran = new Set(recorded);
  const callMessages = new Map<string, number>();
  for (const { message } of docs) {
    const parts: StoredPart[] = Array.isArray(message?.content)
      ? message.content
      : [];
    for (const toolCallId of new Set(
      parts.flatMap((part) =>
        part.type === "tool-call" ? [part.toolCallId] : [],
      ),
    )) {
      callMessages.set(toolCallId, (callMessages.get(toolCallId) ?? 0) + 1);
    }
    for (const part of parts) {
      if (part.type === "tool-approval-request") {
        // A call id can recur in a thread, so a request names the call in
        // its own message.
        const call = parts.find(
          (other): other is Stored<"tool-call"> =>
            other.type === "tool-call" && other.toolCallId === part.toolCallId,
        );
        requests.set(part.approvalId, [
          ...(requests.get(part.approvalId) ?? []),
          { ...part, call },
        ]);
        unanswered.set(part.toolCallId, [
          ...(unanswered.get(part.toolCallId) ?? []),
          part.approvalId,
        ]);
      } else if (
        part.type === "tool-approval-response" &&
        !decisions.has(part.approvalId)
      ) {
        decisions.set(part.approvalId, part);
      } else if (part.type === "tool-result") {
        unanswered.get(part.toolCallId)?.forEach((id) => answered.add(id));
        unanswered.delete(part.toolCallId);
      }
    }
  }
  for (const message of inline) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as {
      type: string;
      approvalId?: string;
    }[]) {
      if (
        part.type === "tool-approval-response" &&
        !decisions.has(part.approvalId!)
      ) {
        throw new Error(
          `Approval ${part.approvalId} is not stored. Save decisions with approveToolCall, denyToolCall or respondToToolCallApprovals, then continue from the returned messageId.`,
        );
      }
    }
  }
  const settled = ({ approvalId }: Request) =>
    answered.has(approvalId) || ran.has(approvalId);

  const plan: ApprovalPlan = {
    callIds: new Set(),
    denials: new Map(),
    continuedCallIds: new Set(),
    continuedProviderApprovalIds: [],
    continuation: [],
  };
  for (const request of [...requests.values()].flat()) {
    plan.callIds.add(request.toolCallId);
    const decision = decisions.get(request.approvalId);
    if (
      decision?.approved === false &&
      !settled(request) &&
      !request.call?.providerExecuted
    ) {
      plan.denials.set(request.approvalId, decision.reason);
    }
  }
  const assistant: StoredPart[] = [];
  const tool: StoredPart[] = [];
  for (const approvalId of continued ?? []) {
    const [request, ...others] = requests.get(approvalId) ?? [];
    if (others.length > 0) {
      throw new Error(
        `Stored context has more than one tool-approval-request for approval ${approvalId}`,
      );
    }
    const decision = decisions.get(approvalId);
    if (!request || !decision || settled(request)) continue;
    const { call, ...requestPart } = request;
    if (!call) {
      throw new Error(`Approval ${approvalId} has no tool call in its message`);
    }
    // A result for a reused call id cannot tell which request it answers.
    if ((callMessages.get(call.toolCallId) ?? 0) > 1) {
      throw new Error(
        `Stored context has more than one tool-call for ${call.toolCallId}`,
      );
    }
    plan.continuedCallIds.add(call.toolCallId);
    if (call.providerExecuted)
      plan.continuedProviderApprovalIds.push(approvalId);
    plan.denials.delete(approvalId);
    assistant.push(call, requestPart);
    tool.push(decision);
  }
  if (tool.length > 0) {
    plan.continuation = structuredClone(
      [
        { role: "assistant", content: assistant },
        { role: "tool", content: tool },
      ].map((message) => toModelMessage(message as Message)),
    );
  }
  return plan;
}

// The context handler sees the fetched context and can return any history, but
// the AI SDK runs local calls decided in the prompt's last message, and a
// provider runs what any decision in the prompt approves. So no approval
// request or decision it returns is sent: the continued approvals are appended
// from storage, and every other approval call is sent only with its result or
// its stored denial, directly after it as strict providers need. One with
// neither is pending and left out, as the AI SDK's convertToModelMessages does.
export function prepareApprovalContext(
  messages: ModelMessage[],
  plan: ApprovalPlan,
): ModelMessage[] {
  const callIds = new Set(plan.callIds);
  for (const part of messages.flatMap(partsOf)) {
    if (part.type === "tool-approval-request") callIds.add(part.toolCallId);
  }
  const isApproval = (toolCallId: string) =>
    callIds.has(toolCallId) && !plan.continuedCallIds.has(toolCallId);
  // A call id can recur, so each approval call is answered by the first result
  // after it: a local call's from a tool message, to move right after it, and
  // a provider-executed call's from wherever it is.
  const localResults = new Map<string, ToolModelMessage>();
  const kept = new Set<string>();
  const open = new Map<string, { at: string; local: boolean }>();
  messages.forEach((message, i) => {
    partsOf(message).forEach((part, j) => {
      if (part.type !== "tool-call" && part.type !== "tool-result") return;
      if (!isApproval(part.toolCallId)) return;
      const id = part.toolCallId;
      if (part.type === "tool-call") {
        if (message.role === "assistant") {
          open.set(id, { at: `${i}:${id}`, local: !part.providerExecuted });
        }
        return;
      }
      const call = open.get(id);
      if (!call || (call.local && message.role !== "tool")) return;
      open.delete(id);
      if (call.local && message.role === "tool") {
        localResults.set(call.at, { ...message, content: [part] });
      } else {
        kept.add(call.at).add(`${i}:${j}`);
      }
    });
  });
  const answer = (part: Call, i: number) => {
    if (part.providerExecuted) return undefined;
    const result = localResults.get(`${i}:${part.toolCallId}`);
    if (result) return result;
    const request = partsOf(messages[i]).find(
      (other) =>
        other.type === "tool-approval-request" &&
        other.toolCallId === part.toolCallId &&
        plan.denials.has(other.approvalId),
    );
    return request?.type === "tool-approval-request"
      ? denial(part, plan.denials.get(request.approvalId))
      : undefined;
  };
  const keep = (part: Part, i: number, j: number): boolean => {
    switch (part.type) {
      case "tool-approval-request":
      case "tool-approval-response":
        return false;
      case "tool-call":
        return (
          !callIds.has(part.toolCallId) ||
          (isApproval(part.toolCallId) &&
            (kept.has(`${i}:${part.toolCallId}`) || !!answer(part, i)))
        );
      case "tool-result":
        return !callIds.has(part.toolCallId) || kept.has(`${i}:${j}`);
      default:
        return true;
    }
  };

  const context: ModelMessage[] = [];
  for (const [i, message] of messages.entries()) {
    if (!Array.isArray(message.content)) {
      context.push(message);
      continue;
    }
    const parts = message.content as Part[];
    const content = parts.filter((part, j) => keep(part, i, j));
    if (content.length === parts.length) context.push(message);
    else if (content.length > 0) {
      context.push({ ...message, content } as ModelMessage);
    }
    if (message.role !== "assistant") continue;
    const answers = content.flatMap((part): ToolModelMessage[] => {
      if (part.type !== "tool-call" || !isApproval(part.toolCallId)) return [];
      const result = answer(part, i);
      return result ? [result] : [];
    });
    if (answers.length > 0) {
      context.push({
        ...answers[0],
        content: answers.flatMap((answer) => answer.content),
      });
    }
  }
  return [...context, ...plan.continuation];
}

function denial(call: Call, reason: string | undefined): ToolModelMessage {
  const result: Result = {
    type: "tool-result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: {
      type: "execution-denied",
      ...(reason !== undefined ? { reason } : {}),
    },
  };
  return { role: "tool", content: [result] };
}

function partsOf(message: ModelMessage): Part[] {
  return Array.isArray(message.content) ? (message.content as Part[]) : [];
}
