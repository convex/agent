import {
  getConvexSize,
  getDocumentSize,
  type Infer,
  type Value,
} from "convex/values";
import type { vDecisionAnswer, vDecisionQuestion } from "./validators.js";
import type { vStoredDecisionAnswer } from "./component/schema.js";

// Shared by the component's decisions module and the client. It's not in
// shared.ts because the component's delete path imports shared.ts, and a second
// importer there makes the bundler split it into one more chunk that every
// delete function then loads.

export const MAX_DOCUMENT_BYTES = 1 << 20;

// What getDocumentSize assumes for an _id it isn't given.
const ESTIMATED_ID = "0".repeat(32);

// Undefined fields aren't stored and add nothing to the size.
function sizeOf(row: object, label: (field: string) => string) {
  const fields = Object.entries(row).map(
    ([field, value]) => [label(field), getConvexSize(value as Value)] as const,
  );
  return {
    size: getDocumentSize(row as Record<string, Value>),
    largest: fields.reduce((a, b) => (b[1] > a[1] ? b : a)),
  };
}

/**
 * A decision's row and its answer rows, corrections included, as Convex sizes
 * them. An answer row not yet stored is sized with an estimated decisionId.
 */
export function decisionSize(
  decision: object,
  answers: readonly ({ questionId: string } & object)[],
) {
  const rows = [
    sizeOf(decision, (field) => field),
    ...answers.map((answer) =>
      sizeOf(
        { decisionId: ESTIMATED_ID, ...answer },
        (field) => `${answer.questionId}'s ${field}`,
      ),
    ),
  ];
  const [name, bytes] = rows
    .map((row) => row.largest)
    .reduce((a, b) => (b[1] > a[1] ? b : a));
  return {
    size: rows.reduce((total, row) => total + row.size, 0),
    largest: `${name} (${bytes} bytes)`,
  };
}

/** Why a decision can't be stored, if it and its answers are over 1 MiB. */
export function decisionTooLarge(
  what: string,
  decision: object,
  answers: readonly ({ questionId: string } & object)[],
): string | undefined {
  const { size, largest } = decisionSize(decision, answers);
  if (size <= MAX_DOCUMENT_BYTES) return undefined;
  return `${what} and its answers are ${size} bytes, over the 1 MiB a decision and its answers can take; the largest field is ${largest}.`;
}

type DecisionAnswer = Infer<typeof vDecisionAnswer>;
type StoredDecisionAnswer = Infer<typeof vStoredDecisionAnswer>;

export function encodeAnswer(answer: DecisionAnswer): StoredDecisionAnswer {
  if (answer.type !== "choice" && answer.type !== "score") return answer;
  const { probabilities, ...rest } = answer;
  return probabilities
    ? { ...rest, probabilities: JSON.stringify(probabilities) }
    : rest;
}

export function decodeAnswer(answer: StoredDecisionAnswer): DecisionAnswer {
  if (answer.type !== "choice" && answer.type !== "score") return answer;
  const { probabilities, ...rest } = answer;
  return probabilities
    ? { ...rest, probabilities: JSON.parse(probabilities) }
    : rest;
}

export function decodeQuestions(
  questions: string,
): Record<string, Infer<typeof vDecisionQuestion>> {
  return JSON.parse(questions);
}

const inUnitRange = (n: number) => n >= 0 && n <= 1;

// A distribution has a probability for every option or level, as the AI SDK
// requires of the model's answers.
function isDistributionOver(
  keys: string[],
  probabilities: Record<string, number> | undefined,
) {
  if (!probabilities) return true;
  const entries = Object.entries(probabilities);
  return (
    entries.length === keys.length &&
    entries.every(([key, p]) => keys.includes(key) && inUnitRange(p))
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
  answer: DecisionAnswer,
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
export function sumsToOne(answer: DecisionAnswer): boolean {
  if (!("probabilities" in answer) || !answer.probabilities) return true;
  const values = Object.values(answer.probabilities);
  const sum = values.reduce((total, p) => total + p, 0);
  return (
    Math.abs(sum - 1) <=
    Math.min(ROUNDING_PER_PROBABILITY * values.length, MAX_ROUNDING)
  );
}
