import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";
import type { MessageDoc } from "../../validators.js";
import { docsToModelMessages } from "../mapping.js";

type ToolPart = ToolModelMessage["content"][number];
type Part =
  | Exclude<AssistantModelMessage["content"], string>[number]
  | ToolPart;
type Request = Extract<Part, { type: "tool-approval-request" }>;
type Response = Extract<Part, { type: "tool-approval-response" }>;

export type ApprovalPlan = {
  hidden: Set<string>;
  replay: Map<string, Response[]>;
  unit: ModelMessage[];
};

// The AI SDK runs only the decisions in the prompt's last message, so approval
// requests and decisions are protocol, not context. A context handler never
// sees them or a call whose approval has not run, and the continued approvals
// are appended after it from storage. Providers read their own decisions from
// anywhere in the prompt, so those of provider-executed approvals that ran are
// replayed after their call.
export function planApprovals(
  stored: MessageDoc[],
  search: MessageDoc[],
  continued: string[],
): ApprovalPlan {
  const plan: ApprovalPlan = { hidden: new Set(), replay: new Map(), unit: [] };
  const [state, searchState] = [stored, search].map((docs) =>
    scan(docsToModelMessages(docs)),
  );
  for (const { requests, decisions, providerCalls, settled } of [
    state,
    searchState,
  ]) {
    for (const request of [...requests.values()].flat()) {
      if (!settled(request)) plan.hidden.add(request.toolCallId);
      else if (providerCalls.has(request.toolCallId)) {
        const replayed = decisions.get(request.approvalId) ?? [];
        plan.replay.set(request.toolCallId, structuredClone(replayed));
      }
    }
  }
  const calls: Part[] = [];
  const decisions: Response[] = [];
  for (const id of continued) {
    const [request] = only(state.requests, "tool-approval-request", id);
    const [decision] = only(state.decisions, "tool-approval-response", id);
    if (!decision || state.settled(request)) continue;
    const [call, ...others] = state.calls.get(request.toolCallId) ?? [];
    if (!call || others.length > 0 || calls.includes(call)) {
      throw new Error(`Approval ${id} must name exactly one tool call`);
    }
    calls.push(call, request);
    decisions.push(decision);
  }
  if (decisions.length > 0) {
    plan.unit = structuredClone([
      { role: "assistant", content: calls },
      { role: "tool", content: decisions },
    ] as ModelMessage[]);
  }
  return plan;
}

// What the context handler is given. Siblings decided in separate batches
// store each result after its own decision, so once the protocol is gone each
// result is moved to directly follow its call.
export function hideApprovals(
  plan: ApprovalPlan,
  segments: ModelMessage[][],
): ModelMessage[][] {
  const answers = new Map<string, ToolModelMessage>();
  return segments
    .map((messages) =>
      strip(plan, messages).flatMap((message): ModelMessage[] => {
        if (message.role === "tool") {
          const content = message.content.filter((part) => {
            const answer =
              part.type === "tool-result" && answers.get(part.toolCallId);
            if (!answer) return true;
            answer.providerOptions ??= message.providerOptions;
            answer.content.push(part);
            return false;
          });
          return content.length > 0 ? [{ ...message, content }] : [];
        }
        const answer: ToolModelMessage = { role: "tool", content: [] };
        const callIds = partsOf(message).flatMap((part) =>
          part.type === "tool-call" && !answers.has(part.toolCallId)
            ? [part.toolCallId]
            : [],
        );
        callIds.forEach((id) => answers.set(id, answer));
        return callIds.length > 0 ? [message, answer] : [message];
      }),
    )
    .map((messages) =>
      messages.filter((m) => m.role !== "tool" || m.content.length > 0),
    );
}

// The plan's parts are cloned on the way out, since the SDK hands the prompt
// to prepareStep, which may edit it in place.
export function finishApprovals(
  plan: ApprovalPlan,
  messages: ModelMessage[],
): ModelMessage[] {
  // A handler can return history the plan never fetched, so approvals still
  // pending there are found in what it returns.
  const returned = scan(messages);
  const hidden = new Set(plan.hidden);
  for (const request of [...returned.requests.values()].flat()) {
    if (!returned.settled(request)) hidden.add(request.toolCallId);
  }
  const context = strip({ ...plan, hidden }, messages).flatMap(
    (message): ModelMessage[] => {
      const replayed = partsOf(message).flatMap((part) =>
        part.type === "tool-call"
          ? structuredClone(plan.replay.get(part.toolCallId) ?? [])
          : [],
      );
      return message.role === "assistant" && replayed.length > 0
        ? [message, { role: "tool", content: replayed }]
        : [message];
    },
  );
  // The SDK runs the continued approvals before it validates the prompt, so an
  // unanswered call would fail the generation after they ran, and a retry
  // would run them again.
  const parts = context.flatMap(partsOf);
  const answered = new Set(
    parts.map((part) => part.type === "tool-result" && part.toolCallId),
  );
  const unanswered = parts.find(
    (part) =>
      part.type === "tool-call" &&
      !part.providerExecuted &&
      !answered.has(part.toolCallId),
  );
  if (unanswered?.type === "tool-call") {
    throw new Error(
      `Context has tool call ${unanswered.toolCallId} without its result`,
    );
  }
  return [...context, ...structuredClone(plan.unit)];
}

function scan(messages: ModelMessage[]) {
  const requests = new Map<string, Request[]>();
  const decisions = new Map<string, Response[]>();
  const calls = new Map<string, Part[]>();
  const providerCalls = new Set<string>();
  const results = new Set<string>();
  const consumed = new Set<string>();
  let waiting: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      // Provider-owned approvals do not always produce a tool-result. A later
      // assistant response is the durable evidence that they were consumed.
      waiting.forEach((approvalId) => consumed.add(approvalId));
      waiting = [];
    }
    for (const part of partsOf(message)) {
      if (part.type === "tool-approval-request") {
        add(requests, part.approvalId, part);
      } else if (part.type === "tool-approval-response") {
        add(decisions, part.approvalId, part);
        waiting.push(part.approvalId);
      } else if (part.type === "tool-call") {
        add(calls, part.toolCallId, part);
        if (part.providerExecuted) providerCalls.add(part.toolCallId);
      } else if (part.type === "tool-result") {
        results.add(part.toolCallId);
      }
    }
  }
  const settled = ({ approvalId, toolCallId }: Request) =>
    results.has(toolCallId) ||
    (providerCalls.has(toolCallId) && consumed.has(approvalId));
  return { requests, decisions, calls, providerCalls, settled };
}

function strip(plan: ApprovalPlan, messages: ModelMessage[]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (!Array.isArray(message.content)) return [message];
    const content = (message.content as Part[]).filter(
      (part) =>
        part.type !== "tool-approval-request" &&
        part.type !== "tool-approval-response" &&
        !(
          (part.type === "tool-call" || part.type === "tool-result") &&
          plan.hidden.has(part.toolCallId)
        ),
    );
    if (content.length === message.content.length) return [message];
    return content.length > 0 ? [{ ...message, content } as ModelMessage] : [];
  });
}

function only<T>(byId: Map<string, T[]>, type: string, approvalId: string) {
  const parts = byId.get(approvalId) ?? [];
  if (parts.length > 1) {
    throw new Error(
      `Stored context has more than one ${type} for approval ${approvalId}`,
    );
  }
  return parts;
}

function add<K, T>(byId: Map<K, T[]>, id: K, part: T) {
  byId.set(id, [...(byId.get(id) ?? []), part]);
}

function partsOf(message: ModelMessage): Part[] {
  return Array.isArray(message.content) ? (message.content as Part[]) : [];
}
