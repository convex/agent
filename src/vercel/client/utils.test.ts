import type { StepResult } from "ai";
import { describe, expect, test } from "vitest";
import { hasSuccessfulToolCall } from "./utils.js";

// Minimal StepResult builder with only the fields hasSuccessfulToolCall
// reads. Loosely typed on purpose so test fixtures can be terse; cast at the
// boundary.
type StepFixture = {
  finishReason?: string;
  content?: Array<{ type: string; toolName?: string }>;
  toolCalls?: Array<{ toolCallId: string; toolName: string }>;
  toolResults?: Array<{ toolCallId: string; toolName: string }>;
};

function makeStep(partial: StepFixture): StepResult<any> {
  return {
    finishReason: "tool-calls",
    content: [],
    toolCalls: [],
    toolResults: [],
    ...partial,
  } as unknown as StepResult<any>;
}

describe("hasSuccessfulToolCall", () => {
  test("returns true when last step has a tool-result for the named tool", () => {
    const step = makeStep({
      content: [{ type: "tool-result", toolName: "search" }],
    });
    expect(hasSuccessfulToolCall("search")({ steps: [step] })).toBe(true);
  });

  test("returns false when only a tool-error is present for the named tool", () => {
    const step = makeStep({
      content: [{ type: "tool-error", toolName: "search" }],
    });
    expect(hasSuccessfulToolCall("search")({ steps: [step] })).toBe(false);
  });

  test("returns false when the matching tool name is missing", () => {
    const step = makeStep({
      content: [{ type: "tool-result", toolName: "other" }],
    });
    expect(hasSuccessfulToolCall("search")({ steps: [step] })).toBe(false);
  });

  test("only inspects the last step", () => {
    const earlier = makeStep({
      content: [{ type: "tool-result", toolName: "search" }],
    });
    const last = makeStep({
      content: [{ type: "tool-error", toolName: "search" }],
    });
    expect(hasSuccessfulToolCall("search")({ steps: [earlier, last] })).toBe(
      false,
    );
  });

  test("returns false when steps is empty", () => {
    expect(hasSuccessfulToolCall("search")({ steps: [] })).toBe(false);
  });
});
