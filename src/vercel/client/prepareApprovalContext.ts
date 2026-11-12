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
type Owned = { key: string; approvalId: string; part: ApprovalPart };

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
    if (part.type !== "tool-approval-request") continue;
    const first = storedRequests.get(part.approvalId);
    if (first && !sameApprovalPart(first, part)) {
      throw new Error(
        `Stored context has more than one ${part.type} for ${partId(part)}`,
      );
    }
    storedRequests.set(part.approvalId, first ?? part);
  }

  const stored = new Map<string, { part: ApprovalPart; role: string }>();
  const waitingProviderApprovalIds = new Set<string>();
  const consumedProviderApprovalIds = new Set<string>();
  const storedOwned = ownedParts(storedContext);
  for (const [m, message] of storedContext.entries()) {
    if (message.role === "assistant") {
      // Provider-owned approvals do not always produce a tool-result. A later
      // assistant response is the durable evidence that they were consumed.
      for (const approvalId of waitingProviderApprovalIds) {
        consumedProviderApprovalIds.add(approvalId);
      }
      waitingProviderApprovalIds.clear();
    }
    for (const owned of storedOwned[m]) {
      if (!owned) continue;
      const { key, approvalId, part } = owned;
      const first = stored.get(key);
      if (first && !sameApprovalPart(first.part, part)) {
        throw new Error(
          `Stored context has more than one ${part.type} for ${partId(part)}`,
        );
      }
      stored.set(key, first ?? { part, role: message.role });
      if (
        part.type === "tool-approval-response" &&
        isProviderCall(stored, approvalId)
      ) {
        waitingProviderApprovalIds.add(approvalId);
      }
    }
  }

  // A handler may return history from outside the fetched context, and those
  // approvals pass through as in any other generation.
  const outsideContext = ({ approvalId }: Owned) =>
    !storedRequests.has(approvalId);

  // Every other approval part a handler returns is a copy of a stored one,
  // in a message of the same role. A handler may repeat a part (cloning the
  // context, say), so the first copy is canonical and carries any part-level
  // provider options it added.
  const supplied = new Map<string, ApprovalPart>();
  const suppliedOwned = suppliedOwnedParts(
    messages,
    storedContext,
    storedOwned,
    storedRequests,
  );
  for (const [m, message] of messages.entries()) {
    for (const owned of suppliedOwned[m]) {
      if (!owned) continue;
      const { key, part } = owned;
      const original = stored.get(key);
      const role = original?.role ?? validRole[part.type];
      if (message.role !== role) {
        throw new Error(
          `Continuation context has a ${part.type} in a ${message.role} message (expected ${role})`,
        );
      }
      if (outsideContext(owned)) continue;
      if (!original) {
        throw new Error(
          `Continuation context cannot add ${addedNoun[part.type]}`,
        );
      }
      if (!sameApprovalPart(original.part, part)) {
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
    const keys = unitKeys(request.approvalId).filter((key) => stored.has(key));
    if (
      !approvalIds.has(request.approvalId) &&
      !keys.some((key) => supplied.has(key))
    ) {
      continue;
    }
    const missing = keys.find((key) => !supplied.has(key));
    if (missing) {
      const { part } = stored.get(missing)!;
      throw new Error(
        `Continuation context removed ${removedNoun[part.type]} for ${partId(part)}`,
      );
    }
  }

  const executable = new Set<string>();
  const undecided = new Set<string>();
  const deferred = new Set<string>();
  for (const approvalId of storedRequests.keys()) {
    if (
      stored.has(`tool-result:${approvalId}`) ||
      consumedProviderApprovalIds.has(approvalId)
    ) {
      continue;
    }
    if (!approvalIds.has(approvalId)) deferred.add(approvalId);
    else if (stored.has(`tool-approval-response:${approvalId}`)) {
      executable.add(approvalId);
    } else undecided.add(approvalId);
  }

  // A handler may clone or reorder the context. The final call/response pair
  // is built once from the canonical parts, so every other occurrence is
  // dropped, and a completed call's result is re-emitted directly after each
  // message that carries the call, so nothing a handler inserts can separate
  // them for providers that require that adjacency.
  const relocated = new Map<string, ToolModelMessage>();
  for (const [m, message] of messages.entries()) {
    if (message.role !== "tool") continue;
    for (const owned of suppliedOwned[m]) {
      if (
        owned?.part.type === "tool-result" &&
        approvalIds.has(owned.approvalId) &&
        !relocated.has(owned.approvalId)
      ) {
        relocated.set(owned.approvalId, { ...message, content: [owned.part] });
      }
    }
  }
  // Message-level provider options (cache control, say) are the handler's,
  // and a handler that targets one message usually means the last one, so the
  // synthesized pair takes the options of the last message it absorbs.
  let assistantOptions: ModelMessage["providerOptions"];
  let toolOptions: ModelMessage["providerOptions"];
  const projected: ModelMessage[] = [];
  for (const [m, message] of messages.entries()) {
    if (!Array.isArray(message.content)) {
      projected.push(message);
      continue;
    }
    const kept = message.content
      .map((part, i) => ({ part, owned: suppliedOwned[m][i] }))
      .filter(({ part, owned }) => {
        if (!owned || outsideContext(owned)) return true;
        const { approvalId } = owned;
        if (
          part.type === "tool-call" ||
          part.type === "tool-approval-request"
        ) {
          if (deferred.has(approvalId) || undecided.has(approvalId)) {
            return false;
          }
          if (executable.has(approvalId)) {
            assistantOptions = message.providerOptions;
            return false;
          }
          return (
            part.type === "tool-call" || isProviderCall(stored, approvalId)
          );
        }
        if (part.type === "tool-approval-response") {
          if (executable.has(approvalId)) {
            toolOptions = message.providerOptions;
            return false;
          }
          return (
            !deferred.has(approvalId) && isProviderCall(stored, approvalId)
          );
        }
        return !relocated.has(approvalId);
      });
    if (kept.length === 0) continue;
    projected.push({
      ...message,
      content: kept.map(({ part }) => part),
    } as ModelMessage);
    if (message.role !== "assistant") continue;
    const results = kept.flatMap(({ part, owned }) =>
      part.type === "tool-call" && owned && relocated.has(owned.approvalId)
        ? [relocated.get(owned.approvalId)!]
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
      if (!executable.has(approvalId)) continue;
      assistant.push(
        supplied.get(`tool-call:${approvalId}`) as Call,
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

// The AI SDK runs the approvals decided in the last message before it builds
// the first step's prompt, appending their results after that message
// (generate-text.ts collectToolApprovals and executeTools). Building the
// prompt then rejects a local call with no result before the next user or
// system message or the end of the prompt (convertToLanguageModelPrompt). So
// a context that breaks this must be refused here, before anything runs.
export function assertToolCallsAnswered(messages: ModelMessage[]): void {
  const requests = new Map<string, string>();
  const unanswered = new Set<string>();
  const throwIfUnanswered = () => {
    const [toolCallId] = unanswered;
    if (toolCallId !== undefined) {
      throw new Error(
        `Continuation context has a tool call with no result: ${toolCallId}`,
      );
    }
  };
  for (const message of messages) {
    if (message.role === "user" || message.role === "system") {
      throwIfUnanswered();
    }
    for (const part of partsOf([message])) {
      if (message.role === "assistant") {
        if (part.type === "tool-call" && !part.providerExecuted) {
          unanswered.add(part.toolCallId);
        } else if (part.type === "tool-approval-request") {
          requests.set(part.approvalId, part.toolCallId);
        }
      } else if (message.role === "tool" && part.type === "tool-result") {
        unanswered.delete(part.toolCallId);
      }
    }
  }
  const last = messages.at(-1);
  if (last?.role === "tool") {
    for (const part of last.content) {
      if (part.type !== "tool-approval-response") continue;
      const toolCallId = requests.get(part.approvalId);
      if (toolCallId !== undefined) unanswered.delete(toolCallId);
    }
  }
  throwIfUnanswered();
}

function partsOf(messages: ModelMessage[]): (AssistantPart | ToolPart)[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as (AssistantPart | ToolPart)[])
      : [],
  );
}

// The approval each part of the stored context belongs to, aligned with its
// content. A model may reuse a toolCallId in a later step, so a call belongs
// to the next request for its id that comes before any result for it (or else
// the latest one), a result belongs to the latest request for its id, and one
// with no such request is ordinary history.
function ownedParts(messages: ModelMessage[]): (Owned | undefined)[][] {
  const contents = messages.map((message) => partsOf([message]));
  const nextRequest = contents.map((content) =>
    content.map((): string | undefined => undefined),
  );
  const next = new Map<string, string>();
  for (let m = contents.length - 1; m >= 0; m--) {
    for (let i = contents[m].length - 1; i >= 0; i--) {
      const part = contents[m][i];
      if (part.type === "tool-approval-request") {
        next.set(part.toolCallId, part.approvalId);
      } else if (part.type === "tool-result") {
        next.delete(part.toolCallId);
      } else if (part.type === "tool-call") {
        nextRequest[m][i] = next.get(part.toolCallId);
      }
    }
  }
  const latest = new Map<string, string>();
  return contents.map((content, m) =>
    content.map((part, i) => {
      let approvalId: string | undefined;
      if (
        part.type === "tool-approval-request" ||
        part.type === "tool-approval-response"
      ) {
        approvalId = part.approvalId;
        if (part.type === "tool-approval-request") {
          latest.set(part.toolCallId, part.approvalId);
        }
      } else if (part.type === "tool-call" || part.type === "tool-result") {
        approvalId =
          (part.type === "tool-call" ? nextRequest[m][i] : undefined) ??
          latest.get(part.toolCallId);
      }
      return ownedBy(part, approvalId);
    }),
  );
}

// A handler may reorder the context, so a call or result it returns takes the
// one owner its id has in the stored context, never one inferred from where
// the handler put it. An id with several owners there is resolved only inside
// a message identical to a stored one, whose parts lend their owners; the
// k-th copy of such a message takes the k-th identical stored message,
// wrapping around for a clone.
function suppliedOwnedParts(
  messages: ModelMessage[],
  storedContext: ModelMessage[],
  storedOwned: (Owned | undefined)[][],
  storedRequests: ReadonlyMap<string, Request>,
): (Owned | undefined)[][] {
  const owners = new Map<string, Set<string | undefined>>();
  storedContext.forEach((message, m) =>
    partsOf([message]).forEach((part, i) => {
      if (part.type !== "tool-call" && part.type !== "tool-result") return;
      const ids = owners.get(part.toolCallId) ?? new Set();
      owners.set(part.toolCallId, ids.add(storedOwned[m][i]?.approvalId));
    }),
  );
  const requested = new Map<string, Set<string | undefined>>();
  for (const { toolCallId, approvalId } of storedRequests.values()) {
    if (owners.has(toolCallId)) continue;
    requested.set(
      toolCallId,
      (requested.get(toolCallId) ?? new Set()).add(approvalId),
    );
  }

  let storedShapes: Map<string, (string | undefined)[][]> | undefined;
  const copies = new Map<string, number>();
  const lend = (message: ModelMessage, toolCallId: string) => {
    if (!storedShapes) {
      storedShapes = new Map();
      for (const [m, stored] of storedContext.entries()) {
        const shape = messageShape(stored);
        if (shape === undefined) continue;
        const parts = partsOf([stored]);
        const lent = storedOwned[m]
          .filter((_, i) => isApprovalPart(parts[i]))
          .map((owned) => owned?.approvalId);
        storedShapes.set(shape, [...(storedShapes.get(shape) ?? []), lent]);
      }
    }
    const shape = messageShape(message)!;
    const matches = storedShapes.get(shape);
    if (!matches) {
      throw new Error(
        `Continuation context reshapes a message with a reused tool call id ${toolCallId}`,
      );
    }
    const copy = copies.get(shape) ?? 0;
    copies.set(shape, copy + 1);
    return matches[copy % matches.length];
  };

  return messages.map((message) => {
    let lent: (string | undefined)[] | undefined;
    let j = -1;
    return partsOf([message]).map((part) => {
      if (!isApprovalPart(part)) return undefined;
      j++;
      if (part.type !== "tool-call" && part.type !== "tool-result") {
        return ownedBy(part, part.approvalId);
      }
      const ids = owners.get(part.toolCallId) ?? requested.get(part.toolCallId);
      if (!ids || ids.size < 2) {
        return ownedBy(part, ids?.values().next().value);
      }
      lent ??= lend(message, part.toolCallId);
      return ownedBy(part, lent[j]);
    });
  });
}

function isApprovalPart(part: AssistantPart | ToolPart): part is ApprovalPart {
  return Object.hasOwn(validRole, part.type);
}

// A message's role and its approval parts, compared as sameApprovalPart does.
function messageShape(message: ModelMessage): string | undefined {
  const parts = partsOf([message]).filter(isApprovalPart);
  return parts.length === 0
    ? undefined
    : JSON.stringify([message.role, ...parts.map(approvalPartSignature)]);
}

function ownedBy(
  part: AssistantPart | ToolPart,
  approvalId: string | undefined,
): Owned | undefined {
  return approvalId === undefined
    ? undefined
    : {
        key: `${part.type}:${approvalId}`,
        approvalId,
        part: part as ApprovalPart,
      };
}

function unitKeys(approvalId: string): string[] {
  return [
    `tool-call:${approvalId}`,
    `tool-approval-request:${approvalId}`,
    `tool-approval-response:${approvalId}`,
    `tool-result:${approvalId}`,
  ];
}

function isProviderCall(
  stored: ReadonlyMap<string, { part: ApprovalPart }>,
  approvalId: string,
): boolean {
  const call = stored.get(`tool-call:${approvalId}`)?.part;
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
