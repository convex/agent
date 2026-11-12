import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";
import { convexToJson, type Value } from "convex/values";
import { encodeToolJsonFields } from "../../streaming/toolJson.js";

type AssistantPart = Exclude<AssistantModelMessage["content"], string>[number];
type Request = Extract<AssistantPart, { type: "tool-approval-request" }>;
type Call = Extract<AssistantPart, { type: "tool-call" }>;
type ToolPart = ToolModelMessage["content"][number];
type Response = Extract<ToolPart, { type: "tool-approval-response" }>;
type Result = Extract<ToolPart, { type: "tool-result" }>;

type ApprovalPart = Request | Call | Response | Result;

const validRole = {
  "tool-approval-request": "assistant",
  "tool-call": "assistant",
  "tool-approval-response": "tool",
  "tool-result": "tool",
} as const;
const addedNoun = {
  "tool-approval-request": "approval requests",
  "tool-call": "approved tool calls",
  "tool-approval-response": "approval decisions",
  "tool-result": "results for approved tool calls",
} as const;
const removedNoun = {
  "tool-approval-request": "request",
  "tool-call": "call",
  "tool-approval-response": "decision",
  "tool-result": "result",
} as const;

// The AI SDK runs the approvals in the context's last message whose call has
// no result in that same message (collectToolApprovals), and never sends a
// local approval's request or decision to the provider. So a local approval
// appears as request and decision only in the final synthesized pair, and
// elsewhere as just its call and result.
export function prepareApprovalContext(
  messages: ModelMessage[],
  approvalIds: ReadonlySet<string>,
  storedContext: ModelMessage[],
): ModelMessage[] {
  const storedRequests = new Map<string, Request>();
  for (const part of partsOf(storedContext)) {
    if (part.type === "tool-approval-request") {
      storedRequests.set(part.approvalId, part);
    }
  }
  const approvalCallIds = new Set(
    [...storedRequests.values()].map((request) => request.toolCallId),
  );

  const stored = new Map<string, ApprovalPart>();
  const waitingProviderApprovalIds = new Set<string>();
  const consumedProviderApprovalIds = new Set<string>();
  for (const message of storedContext) {
    if (message.role === "assistant") {
      // Provider-owned approvals do not always produce a tool-result. A later
      // assistant response is the durable evidence that they were consumed.
      for (const approvalId of waitingProviderApprovalIds) {
        consumedProviderApprovalIds.add(approvalId);
      }
      waitingProviderApprovalIds.clear();
    }
    for (const [key, part] of approvalParts(message, approvalCallIds)) {
      const first = stored.get(key);
      if (first && !sameApprovalPart(first, part)) {
        throw new Error(
          `Stored context has more than one ${part.type} for ${partId(part)}`,
        );
      }
      stored.set(key, first ?? part);
      if (
        part.type === "tool-approval-response" &&
        isProviderCall(stored, storedRequests.get(part.approvalId)!.toolCallId)
      ) {
        waitingProviderApprovalIds.add(part.approvalId);
      }
    }
  }

  // Every approval part a handler returns is a copy of a stored one. A handler
  // may repeat a part (cloning the context, say), so the first copy is
  // canonical and carries any part-level provider options it added.
  const supplied = new Map<string, ApprovalPart>();
  for (const message of messages) {
    for (const [key, part] of approvalParts(message, approvalCallIds)) {
      if (message.role !== validRole[part.type]) {
        throw new Error(
          `Continuation context has a ${part.type} in a ${message.role} message`,
        );
      }
      const original = stored.get(key);
      if (!original) {
        throw new Error(
          `Continuation context cannot add ${addedNoun[part.type]}`,
        );
      }
      if (!sameApprovalPart(original, part)) {
        throw new Error(
          `Continuation context must preserve the stored ${part.type} for ${partId(part)}`,
        );
      }
      if (!supplied.has(key)) supplied.set(key, part);
    }
  }
  // An approval is kept or dropped whole, and the ones being continued are
  // kept, so a handler can trim history but not separate a decision or result
  // from the call it belongs to.
  for (const request of storedRequests.values()) {
    const keys = unitKeys(request).filter((key) => stored.has(key));
    if (
      !approvalIds.has(request.approvalId) &&
      !keys.some((key) => supplied.has(key))
    ) {
      continue;
    }
    const missing = keys.find((key) => !supplied.has(key));
    if (missing) {
      const part = stored.get(missing)!;
      throw new Error(
        `Continuation context removed ${removedNoun[part.type]} for ${partId(part)}`,
      );
    }
  }

  const activeCallIds = new Set<string>();
  const executable = new Set<string>();
  const undecided = new Set<string>();
  const deferred = new Set<string>();
  for (const [approvalId, { toolCallId }] of storedRequests) {
    if (approvalIds.has(approvalId)) activeCallIds.add(toolCallId);
    if (
      stored.has(`tool-result:${toolCallId}`) ||
      consumedProviderApprovalIds.has(approvalId)
    ) {
      continue;
    }
    if (!approvalIds.has(approvalId)) deferred.add(toolCallId);
    else if (stored.has(`tool-approval-response:${approvalId}`)) {
      executable.add(toolCallId);
    } else undecided.add(toolCallId);
  }

  // A handler may clone or reorder the context. The final call/response pair
  // is built once from the canonical parts, so every other occurrence is
  // dropped, and a completed call's result is re-emitted directly after each
  // message that carries the call, so nothing a handler inserts can separate
  // them for providers that require that adjacency.
  const relocated = new Map<string, ToolModelMessage>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (
        part.type === "tool-result" &&
        activeCallIds.has(part.toolCallId) &&
        !relocated.has(part.toolCallId)
      ) {
        relocated.set(part.toolCallId, { ...message, content: [part] });
      }
    }
  }
  // Message-level provider options (cache control, say) are the handler's,
  // and a handler that targets one message usually means the last one, so the
  // synthesized pair takes the options of the last message it absorbs.
  let assistantOptions: ModelMessage["providerOptions"];
  let toolOptions: ModelMessage["providerOptions"];
  const projected: ModelMessage[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      projected.push(message);
      continue;
    }
    const content = message.content.filter((part) => {
      if (part.type === "tool-call" || part.type === "tool-approval-request") {
        if (deferred.has(part.toolCallId) || undecided.has(part.toolCallId)) {
          return false;
        }
        if (executable.has(part.toolCallId)) {
          assistantOptions = message.providerOptions;
          return false;
        }
        return (
          part.type === "tool-call" || isProviderCall(stored, part.toolCallId)
        );
      }
      if (part.type === "tool-approval-response") {
        const { toolCallId } = storedRequests.get(part.approvalId)!;
        if (executable.has(toolCallId)) {
          toolOptions = message.providerOptions;
          return false;
        }
        return !deferred.has(toolCallId) && isProviderCall(stored, toolCallId);
      }
      if (part.type === "tool-result" && relocated.has(part.toolCallId)) {
        return false;
      }
      return true;
    });
    if (content.length === 0) continue;
    projected.push({ ...message, content } as ModelMessage);
    if (message.role !== "assistant") continue;
    const results = content.flatMap((part) =>
      part.type === "tool-call" && relocated.has(part.toolCallId)
        ? [relocated.get(part.toolCallId)!]
        : [],
    );
    if (results.length > 0) {
      projected.push({
        ...results[0],
        content: results.flatMap((result) => result.content),
      });
    }
  }
  if (executable.size > 0) {
    const assistant: AssistantPart[] = [];
    const tool: Response[] = [];
    for (const approvalId of approvalIds) {
      const { toolCallId } = storedRequests.get(approvalId)!;
      if (!executable.has(toolCallId)) continue;
      assistant.push(
        supplied.get(`tool-call:${toolCallId}`) as Call,
        supplied.get(`tool-approval-request:${approvalId}`) as Request,
      );
      tool.push(
        supplied.get(`tool-approval-response:${approvalId}`) as Response,
      );
    }
    projected.push(
      {
        role: "assistant",
        content: assistant,
        ...withOptions(assistantOptions),
      },
      { role: "tool", content: tool, ...withOptions(toolOptions) },
    );
  }
  return projected;
}

function partsOf(messages: ModelMessage[]): (AssistantPart | ToolPart)[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as (AssistantPart | ToolPart)[])
      : [],
  );
}

function approvalParts(
  message: ModelMessage,
  approvalCallIds: ReadonlySet<string>,
): [string, ApprovalPart][] {
  return partsOf([message]).flatMap((part): [string, ApprovalPart][] => {
    switch (part.type) {
      case "tool-approval-request":
      case "tool-approval-response":
        return [[`${part.type}:${part.approvalId}`, part]];
      case "tool-call":
      case "tool-result":
        return approvalCallIds.has(part.toolCallId)
          ? [[`${part.type}:${part.toolCallId}`, part]]
          : [];
      default:
        return [];
    }
  });
}

function unitKeys({ approvalId, toolCallId }: Request): string[] {
  return [
    `tool-call:${toolCallId}`,
    `tool-approval-request:${approvalId}`,
    `tool-approval-response:${approvalId}`,
    `tool-result:${toolCallId}`,
  ];
}

function isProviderCall(
  stored: ReadonlyMap<string, ApprovalPart>,
  toolCallId: string,
): boolean {
  const call = stored.get(`tool-call:${toolCallId}`);
  return call?.type === "tool-call" && call.providerExecuted === true;
}

function withOptions(providerOptions: ModelMessage["providerOptions"]) {
  return providerOptions ? { providerOptions } : {};
}

function partId(part: ApprovalPart): string {
  return part.type === "tool-approval-request" ||
    part.type === "tool-approval-response"
    ? `approval ${part.approvalId}`
    : part.toolCallId;
}

// Part-level provider options are the handler's to add, and a result's output
// is the handler's to redact or trim since it cannot cause execution;
// everything else must match what was stored.
function sameApprovalPart(a: ApprovalPart, b: ApprovalPart): boolean {
  return approvalPartSignature(a) === approvalPartSignature(b);
}

function approvalPartSignature(part: ApprovalPart): string {
  switch (part.type) {
    case "tool-approval-request":
      return signature({
        type: part.type,
        approvalId: part.approvalId,
        toolCallId: part.toolCallId,
        isAutomatic: part.isAutomatic ?? false,
        signature: part.signature,
      });
    case "tool-call":
      return signature(
        encodeToolJsonFields(
          {
            type: part.type,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            providerExecuted: part.providerExecuted ?? false,
          },
          "input",
        ),
      );
    case "tool-approval-response":
      return signature({
        type: part.type,
        approvalId: part.approvalId,
        approved: part.approved,
        reason: part.reason,
        providerExecuted: part.providerExecuted ?? false,
      });
    case "tool-result":
      return signature({
        type: part.type,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
      });
  }
}

function signature(value: unknown): string {
  return JSON.stringify(convexToJson((value ?? null) as Value));
}
