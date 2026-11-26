import type { Infer } from "convex/values";
import type { vDecisionAnswer } from "./validators.js";

// Shared by the component's decisions module and the client. It's not in
// shared.ts because the component's delete path imports shared.ts, and a second
// importer there makes the bundler split it into one more chunk that every
// delete function then loads.

const inUnitRange = (n: number) => n >= 0 && n <= 1;

function isDistributionOver(
  keys: string[],
  probabilities: Record<string, number> | undefined,
) {
  return Object.entries(probabilities ?? {}).every(
    ([key, p]) => keys.includes(key) && inUnitRange(p),
  );
}

type DecisionQuestionLike =
  | { type: "choice"; criteria: Readonly<Record<string, unknown>> }
  | { type: "score"; criteria: readonly unknown[] }
  | { type: "box" | "boolean" };

/**
 * Whether a stored answer answers the question as defined: the same type, and
 * within its options, levels or ranges.
 */
export function answersQuestion(
  question: DecisionQuestionLike,
  answer: Infer<typeof vDecisionAnswer>,
): boolean {
  if (answer.type === "choice" && question.type === "choice") {
    const options = Object.keys(question.criteria);
    return (
      options.includes(answer.choice) &&
      isDistributionOver(options, answer.probabilities)
    );
  }
  if (answer.type === "score" && question.type === "score") {
    const levels = question.criteria.map((_, level) => String(level));
    return (
      answer.score >= 0 &&
      answer.score <= levels.length - 1 &&
      isDistributionOver(levels, answer.probabilities)
    );
  }
  if (answer.type === "boolean" && question.type === "boolean") {
    return inUnitRange(answer.probability);
  }
  if (answer.type === "box" && question.type === "box") {
    const { top, bottom, left, right } = answer.box;
    return (
      Object.values(answer.box).every(inUnitRange) &&
      top <= bottom &&
      left <= right
    );
  }
  return false;
}

// Half a unit in the second decimal place per value, the coarsest rounding a
// person or provider is likely to use, capped so many options can't sum to
// anything. The AI SDK doesn't export its own tolerance.
const ROUNDING_PER_PROBABILITY = 0.005;
const MAX_ROUNDING = 0.05;

/** Whether an answer's probabilities, if it has any, sum to 1 within rounding. */
export function sumsToOne(answer: Infer<typeof vDecisionAnswer>): boolean {
  if (!("probabilities" in answer) || !answer.probabilities) return true;
  const values = Object.values(answer.probabilities);
  const sum = values.reduce((total, p) => total + p, 0);
  return (
    Math.abs(sum - 1) <=
    Math.min(ROUNDING_PER_PROBABILITY * values.length, MAX_ROUNDING)
  );
}
