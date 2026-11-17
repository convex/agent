import type { ModelMessage, ToolModelMessage, ToolSet } from "ai";
import type { ActionCtx, AgentComponent } from "./types.js";
import { errorToString } from "./utils.js";

/**
 * Thrown when a durable generation (`pendingMessageId`) may not run.
 * - `TurnBusy`: another attempt holds the turn. It can be retried at
 *   `retryAt`, when its lease expires.
 * - `TurnEnded`: the pending message was answered, or the turn stopped:
 *   `reason` says why (for example its pending message or prompt was filled,
 *   failed or deleted by another writer, or its stream was aborted).
 */
export class TurnError extends Error {
  readonly code: "TurnBusy" | "TurnEnded";
  readonly retryAt?: number;
  readonly reason?: string;
  constructor(refused: {
    code: "TurnBusy" | "TurnEnded";
    retryAt?: number;
    error?: string;
  }) {
    super(
      refused.code === "TurnBusy"
        ? `TurnBusy: another attempt holds this turn${
            refused.retryAt
              ? ` until ${new Date(refused.retryAt).toISOString()}`
              : ""
          }`
        : `TurnEnded: this turn has ended${
            refused.error ? `: ${refused.error}` : ""
          }`,
    );
    this.name = "TurnError";
    this.code = refused.code;
    if (refused.retryAt !== undefined) this.retryAt = refused.retryAt;
    if (refused.error !== undefined) this.reason = refused.error;
  }
}

/** Passed by generateText and streamText, the only drivers of a turn. */
export const turnDriver = Symbol("turnDriver");

export type Turn = {
  turnId: string;
  attempt: number;
  step: number;
  order: number;
  slotId: string;
  stepOrder: number;
  anchorId: string;
  /** A tool started since the attempt's last committed save. */
  unsaved: boolean;
};

export async function claimTurn(
  ctx: ActionCtx,
  component: AgentComponent,
  {
    threadId,
    pendingMessageId,
  }: { threadId: string; pendingMessageId: string },
): Promise<Turn> {
  const claimed = await ctx.runMutation(component.turns.claim, {
    threadId,
    messageId: pendingMessageId,
  });
  if ("refused" in claimed) throw new TurnError(claimed.refused);
  const { takeover, ...claimedTurn } = claimed;
  const turn = { ...claimedTurn, unsaved: false };
  // An attempt whose lease expired may have left its stream running.
  if (takeover) {
    try {
      await ctx.runMutation(component.streams.abortByOrder, {
        threadId,
        order: turn.order,
        reason: "The turn was taken over",
      });
    } catch (error) {
      await failTurn(ctx, component, turn, errorToString(error));
      throw error;
    }
  }
  return turn;
}

/**
 * The attempt's one failure write. A stream refusal stops the turn. Otherwise
 * it releases only if no tool started since the last committed save, so
 * whatever failed the attempt, nothing it left unsaved can run twice.
 */
export async function failTurn(
  ctx: ActionCtx,
  component: AgentComponent,
  turn: Turn,
  error: string,
  stopped?: string,
) {
  await ctx.runMutation(component.turns.fail, {
    turnId: turn.turnId,
    attempt: turn.attempt,
    error: stopped ?? error,
    then: stopped !== undefined ? "stop" : turn.unsaved ? "hold" : "release",
  });
}

/**
 * Marks the turn unsaved when a tool starts, and refuses to start one once
 * the attempt is ending.
 */
export function trackToolStarts<TOOLS extends ToolSet>(
  tools: TOOLS | undefined,
  turn: Turn,
  ending: () => boolean,
): TOOLS | undefined {
  if (!tools) return tools;
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const execute = tool.execute;
      if (!execute) return [name, tool];
      return [
        name,
        {
          ...tool,
          // Agent tools read their ctx from `this`.
          execute(this: unknown, ...args: Parameters<typeof execute>) {
            if (ending()) throw new Error("The generation has ended");
            turn.unsaved = true;
            return execute.apply(this, args);
          },
        },
      ];
    }),
  ) as TOOLS;
}

export function mergeTrailingToolMessages(messages: ModelMessage[]) {
  let start = messages.length;
  while (start > 0 && messages[start - 1].role === "tool") start--;
  if (messages.length - start < 2) return messages;
  const tail = messages.slice(start) as ToolModelMessage[];
  return [
    ...messages.slice(0, start),
    { role: "tool" as const, content: tail.flatMap((m) => m.content) },
  ];
}
