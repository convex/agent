import type { Context } from "@ai-sdk/provider-utils";
import type { ModelMessage, StepResult, ToolSet } from "ai";
import type { GenerationControls } from "./start.js";

type StagedStep<TOOLS extends ToolSet, RUNTIME_CONTEXT extends Context> = {
  step: StepResult<TOOLS, RUNTIME_CONTEXT>;
  responseMessages: ModelMessage[];
};

/**
 * Saves each step once the AI SDK has shown what follows it, rather than
 * predicting whether it will run another step (issue #388). A step is
 * intermediate once the next one is being prepared and final once the
 * generation ends. A failure in between wins over a completed but unsaved
 * step (#326): the pending message is failed and the step's content is kept
 * under that failure.
 */
export class StepLifecycle<
  TOOLS extends ToolSet,
  RUNTIME_CONTEXT extends Context,
> {
  #controls: GenerationControls;
  #onSaveFailure: ((error: unknown) => void) | undefined;
  #initialResponseMessages: ModelMessage[] = [];
  #initialResponseMessagesStaged = false;
  #staged: StagedStep<TOOLS, RUNTIME_CONTEXT> | undefined;
  #saves: Promise<void> = Promise.resolve();
  #saveFailure: { error: unknown } | undefined;
  #stepUnderFailure: StagedStep<TOOLS, RUNTIME_CONTEXT> | undefined;

  constructor(
    controls: GenerationControls,
    options: {
      /**
       * Whether the step's parts were streamed as deltas. Failing the message
       * materializes its stream's deltas into it, so once that succeeds a
       * step under the failure only has its handlers run.
       */
      streamed: boolean;
      onSaveFailure?: (error: unknown) => void;
    },
  ) {
    this.#controls = controls;
    this.#onSaveFailure = options.onSaveFailure;
    // `before` runs synchronously when the failure starts, so the step is
    // claimed before a concurrent prepareStep can save it as intermediate.
    controls.setFailHooks({
      before: () => {
        this.#stepUnderFailure ??= this.#takeStaged();
        return this.#saves;
      },
      after: (messageFailed) => {
        const step = this.#stepUnderFailure;
        this.#stepUnderFailure = undefined;
        return this.#save(
          step,
          false,
          !options.streamed || !messageFailed,
        ).catch(() => {});
      },
    });
  }

  /** Call from `prepareStep`, which the AI SDK only runs for a step it runs. */
  async stepStarting(options: {
    stepNumber: number;
    responseMessages: ModelMessage[];
  }): Promise<void> {
    if (options.stepNumber === 0) {
      this.#initialResponseMessages = [...options.responseMessages];
    }
    await this.#save(this.#takeStaged(), true);
  }

  stepEnded(step: StepResult<TOOLS, RUNTIME_CONTEXT>): void {
    this.#staged = {
      step,
      responseMessages: [
        ...(this.#initialResponseMessagesStaged
          ? []
          : this.#initialResponseMessages),
        ...step.response.messages,
      ],
    };
    this.#initialResponseMessagesStaged = true;
  }

  /**
   * Saves the step the generation ended on. Resolves to whether there was
   * one. A failure to store it is thrown, and the step is kept for the
   * failure to save, as for any other step.
   */
  async finalize(finishStreamId?: string): Promise<boolean> {
    await this.#saves;
    const staged = this.#takeStaged();
    if (!staged) return false;
    await this.#save(staged, false, true, finishStreamId);
    return true;
  }

  /**
   * Ends the generation, then runs the caller's `onEnd`, so it sees every step
   * saved. A failure to end is recorded. A throwing caller `onEnd` is ignored,
   * as the AI SDK's notify does.
   */
  async ended(
    end: () => Promise<unknown>,
    callerOnEnd: () => unknown,
  ): Promise<void> {
    try {
      await end();
    } catch (error) {
      this.recordSaveFailure(error);
    }
    await Promise.resolve()
      .then(callerOnEnd)
      .catch(() => {});
  }

  recordSaveFailure(error: unknown): void {
    if (this.#saveFailure?.error === error) return;
    this.#saveFailure ??= { error };
    this.#onSaveFailure?.(error);
  }

  throwSaveFailure(): void {
    if (this.#saveFailure) throw this.#saveFailure.error;
  }

  #takeStaged(): StagedStep<TOOLS, RUNTIME_CONTEXT> | undefined {
    const staged = this.#staged;
    this.#staged = undefined;
    return staged;
  }

  // Callers detach the step before awaiting so it is saved at most once, and
  // saves are chained so a failure always lands after the step before it.
  // A step whose messages could not be stored rejects, so the caller stops
  // the generation instead of letting a later step finalize without it; it is
  // kept for the failure to save. A handler failure after storing is only
  // recorded.
  #save(
    step: StagedStep<TOOLS, RUNTIME_CONTEXT> | undefined,
    createPendingMessage: boolean,
    storeMessages = true,
    finishStreamId?: string,
  ): Promise<void> {
    if (!step) return this.#saves;
    const saving = this.#saves.then(async () => {
      if (storeMessages) {
        try {
          await this.#controls.store(
            step as StagedStep<ToolSet, Context>,
            createPendingMessage,
            finishStreamId,
          );
        } catch (error) {
          this.#stepUnderFailure ??= step;
          this.recordSaveFailure(error);
          throw error;
        }
      }
      try {
        await this.#controls.runHandlers(step as StagedStep<ToolSet, Context>);
      } catch (error) {
        this.recordSaveFailure(error);
      }
    });
    this.#saves = saving.catch(() => {});
    return saving;
  }
}
