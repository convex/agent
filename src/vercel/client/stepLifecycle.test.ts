import type { StepResult, ToolSet } from "ai";
import type { Context } from "@ai-sdk/provider-utils";
import { describe, expect, test } from "vitest";
import type { GenerationControls } from "./start.js";
import { StepLifecycle } from "./stepLifecycle.js";

function lifecycle(storeRejects: boolean) {
  let onFail: ((reason: string) => Promise<void>) | undefined;
  const stored: { failure?: string }[] = [];
  let handlerRuns = 0;
  const controls: GenerationControls = {
    setOnFail: (hook) => {
      onFail = hook;
    },
    store: async (_step, options) => {
      if (storeRejects) throw new Error("store failed");
      stored.push({ failure: options?.failure });
    },
    runHandlers: async () => {
      handlerRuns += 1;
    },
  };
  const steps = new StepLifecycle<ToolSet, Context>(controls);
  steps.stepEnded({
    response: { messages: [] },
  } as unknown as StepResult<ToolSet, Context>);
  return {
    fail: (reason: string) => onFail!(reason),
    stored,
    handlerRuns: () => handlerRuns,
  };
}

describe("StepLifecycle under a failure with an empty reason", () => {
  test("stores the step as failed", async () => {
    const steps = lifecycle(false);
    await steps.fail("");
    expect(steps.stored).toEqual([{ failure: "" }]);
    expect(steps.handlerRuns()).toBe(1);
  });

  test("still runs the handlers when the store fails", async () => {
    const steps = lifecycle(true);
    await steps.fail("");
    expect(steps.handlerRuns()).toBe(1);
  });
});
