import type { StopCondition } from "ai";

export { errorToString } from "../../errors.js";

/**
 * A stop condition that only matches tool calls of the given name which
 * completed successfully — i.e. produced a `tool-result` content part.
 * Failed tool calls (which surface as `tool-error` parts under AI SDK v6)
 * do not match.
 *
 * Use this instead of the AI SDK's `hasToolCall` when you want the agent
 * to retry on argument-validation or runtime tool failures rather than
 * stopping. Evaluated only against the last step (consistent with how
 * `stopWhen` is applied after each step).
 */
export function hasSuccessfulToolCall(toolName: string): StopCondition<any> {
  return ({ steps }) =>
    steps[steps.length - 1]?.content?.some(
      (p) => p.type === "tool-result" && p.toolName === toolName,
    ) ?? false;
}
