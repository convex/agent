import type {
  ModelMessage,
  StepResult,
  StreamTextResult,
  ToolSet,
  UIMessage as AIUIMessage,
} from "ai";
import type { Context } from "@ai-sdk/provider-utils";
import { streamText as streamTextAi } from "ai";
import {
  compressUIMessageChunks,
  DEFAULT_STREAMING_OPTIONS,
  DeltaStreamer,
  mergeTransforms,
  type StreamingOptions,
} from "./streaming.js";
import type {
  ActionCtx,
  AgentComponent,
  GenerationOutputMetadata,
  Options,
  StreamingTextArgs,
} from "./types.js";
import type { Output as AISDKOutput } from "ai";
import { startGeneration } from "./start.js";
import type { Agent } from "../index.js";
import { getModelName, getProviderName } from "../../shared.js";
import { errorToString, willContinue } from "./utils.js";
import { materializeUIMessageChunkFiles } from "../fileMaterialization.js";

export async function runStreamCleanup(cleanup: {
  failCall: () => Promise<void>;
  failStreamer: () => Promise<void>;
  onAbort?: () => PromiseLike<void> | void;
}): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => cleanup.failCall()),
    Promise.resolve().then(() => cleanup.failStreamer()),
  ]);
  const [abortResult] = await Promise.allSettled([
    Promise.resolve().then(() => cleanup.onAbort?.()),
  ]);
  const failure = [...results, abortResult].find(
    (result) => result.status === "rejected",
  );
  if (failure?.status === "rejected") throw failure.reason;
}

/**
 * This behaves like {@link streamText} from the "ai" package except that
 * it add context based on the userId and threadId and saves the input and
 * resulting messages to the thread, if specified.
 * Use {@link continueThread} to get a version of this function already scoped
 * to a thread (and optionally userId).
 */
export async function streamText<
  AgentTools extends ToolSet,
  TOOLS extends ToolSet | undefined = undefined,
  OUTPUT extends AISDKOutput.Output<any, any, any> = AISDKOutput.Output<
    string,
    string,
    never
  >,
  RUNTIME_CONTEXT extends Context = Context,
>(
  ctx: ActionCtx,
  component: AgentComponent,
  /**
   * The arguments to the streamText function, similar to the ai sdk's
   * {@link streamText} function, along with Agent prompt options.
   */
  streamTextArgs: StreamingTextArgs<AgentTools, TOOLS, OUTPUT, RUNTIME_CONTEXT>,
  /**
   * The {@link ContextOptions} and {@link StorageOptions}
   * options to use for fetching contextual messages and saving input/output messages.
   */
  options: Options & {
    agentName: string;
    userId?: string | null;
    threadId?: string;
    /**
     * Whether to save incremental data (deltas) from streaming responses.
     * Defaults to false.
     * If false, it will not save any deltas to the database.
     * If true, it will save deltas with {@link DEFAULT_STREAMING_OPTIONS}.
     *
     * Regardless of this option, when streaming you are able to use this
     * `streamText` function as you would with the "ai" package's version:
     * iterating over the text, streaming it over HTTP, etc.
     */
    saveStreamDeltas?: boolean | StreamingOptions;
    agentForToolCtx?: Agent;
  },
): Promise<
  StreamTextResult<
    TOOLS extends undefined ? AgentTools : TOOLS,
    RUNTIME_CONTEXT,
    OUTPUT
  > &
    GenerationOutputMetadata
> {
  type Tools = TOOLS extends undefined ? AgentTools : TOOLS;
  const { threadId } = options ?? {};
  const { args, userId, order, stepOrder, promptMessageId, ...call } =
    await startGeneration<
      StreamingTextArgs<AgentTools, TOOLS, OUTPUT, RUNTIME_CONTEXT>,
      Tools,
      object,
      RUNTIME_CONTEXT
    >(ctx, component, streamTextArgs, options, "streamText");

  const steps: StepResult<Tools, RUNTIME_CONTEXT>[] = [];
  let firstStreamError: string | undefined;
  let streamCleanupFailure: { error: unknown } | undefined;
  let initialResponseMessages: ModelMessage[] = [];
  let initialResponseMessagesSaved = false;
  const responseMessagesForStep = (
    step: StepResult<Tools, RUNTIME_CONTEXT>,
  ) => [
    ...(initialResponseMessagesSaved ? [] : initialResponseMessages),
    ...step.response.messages,
  ];

  // Track the final step for atomic save with stream finish (issue #181).
  // Only used when streamText awaits stream consumption itself; the
  // `returnImmediately` path saves inline instead (see onStepFinish below).
  let pendingFinalStep:
    | {
        step: StepResult<Tools, RUNTIME_CONTEXT>;
        responseMessages: ModelMessage[];
      }
    | undefined;

  // Whether streamText will await stream consumption before returning.
  // When false (saveStreamDeltas.returnImmediately === true), we cannot
  // defer the final-step save to a post-await block — the function has
  // already returned by the time onStepFinish fires. See issue #265.
  const savesMessages = options?.storageOptions?.saveMessages !== "none";
  const willAwaitStream =
    Boolean(threadId) &&
    (options.saveStreamDeltas === true ||
      (typeof options.saveStreamDeltas === "object" &&
        !options.saveStreamDeltas.returnImmediately));

  const streamer =
    threadId && options.saveStreamDeltas
      ? new DeltaStreamer(
          component,
          ctx,
          {
            throttleMs:
              typeof options.saveStreamDeltas === "object"
                ? options.saveStreamDeltas.throttleMs
                : undefined,
            onAsyncAbort: call.fail,
            compress: compressUIMessageChunks,
            materialize: (parts) =>
              materializeUIMessageChunkFiles(ctx, component, parts),
            abortSignal: args.abortSignal,
            // The message save finishes the stream row atomically (issue
            // #181) — but only when there is a save. With saveMessages set to
            // "none" nothing does, so the streamer keeps finish ownership.
            finishHandledExternally: savesMessages,
          },
          {
            threadId,
            userId,
            agentName: options?.agentName,
            model: getModelName(args.model),
            provider: getProviderName(args.model),
            providerOptions: args.providerOptions,
            format: "UIMessageChunk",
            order,
            stepOrder,
          },
        )
      : undefined;

  const result = streamTextAi<Tools, RUNTIME_CONTEXT, OUTPUT>({
    ...args,
    abortSignal: streamer?.abortController.signal ?? args.abortSignal,
    experimental_transform: mergeTransforms(
      options?.saveStreamDeltas,
      streamTextArgs.experimental_transform,
    ),
    onError: async (error) => {
      console.error("onError", error);
      const reason = (firstStreamError ??= errorToString(error.error));
      try {
        await runStreamCleanup({
          failCall: () => call.fail(reason),
          failStreamer: async () => streamer?.fail(reason),
        });
      } catch (cleanupError) {
        streamCleanupFailure ??= { error: cleanupError };
        console.error("Failed to clean up errored stream:", cleanupError);
      }
      return streamTextArgs.onError?.(error);
    },
    onAbort: async (event) => {
      const providerTriggeredAbort =
        firstStreamError !== undefined && !args.abortSignal?.aborted;
      if (providerTriggeredAbort) return;
      const reason = args.abortSignal?.reason
        ? errorToString(args.abortSignal.reason)
        : "streamText aborted";
      await runStreamCleanup({
        failCall: () => call.fail(reason),
        failStreamer: async () => streamer?.fail(reason),
        onAbort: () => streamTextArgs.onAbort?.(event),
      });
    },
    prepareStep: async (options) => {
      if (options.stepNumber === 0)
        initialResponseMessages = [...options.responseMessages];
      const result = await streamTextArgs.prepareStep?.(options);
      if (result) {
        const model = result.model ?? options.model;
        call.updateModel(model);
        // streamer?.updateMetadata({
        //   model: getModelName(model),
        //   provider: getProviderName(model),
        //   providerOptions: options.messages.at(-1)?.providerOptions,
        // });
        return result;
      }
      return undefined;
    },
    onStepEnd: async (step) => {
      steps.push(step);
      const createPendingMessage = await willContinue(steps, args.stopWhen);
      if (!createPendingMessage && streamer) {
        // Final step with streaming enabled.
        if (willAwaitStream) {
          // We're about to `await stream` below — defer the save so it
          // happens atomically with stream finish (issue #181). Don't touch
          // the streamer here: the stream-level `finish` chunk is emitted
          // after this callback, so the row has to stay `streaming` and keep
          // accepting parts until consumeStream reaches EOF, which is the only
          // point where everything has actually been handed over.
          pendingFinalStep = {
            step,
            responseMessages: responseMessagesForStep(step),
          };
        } else {
          // returnImmediately path: streamText is about to return without
          // awaiting consumption, so the deferred-save block below won't
          // see this step. Save inline now (issue #265). Nothing awaits the
          // stream here, so this is the last moment we can drain deltas, see
          // flushAndStopAccepting for the window that leaves.
          await streamer.flushAndStopAccepting();
          const finishStreamId = await streamer.getOrCreateStreamId({
            ifAborted: "returnUndefined",
          });
          if (finishStreamId) {
            await call.save(
              { step, responseMessages: responseMessagesForStep(step) },
              false,
              finishStreamId,
            );
            // The save finishes the row only when it stores messages. With
            // saveMessages "none" nothing else will, so do it here.
            if (!savesMessages) {
              await streamer.finish();
            }
            initialResponseMessagesSaved = true;
          }
        }
      } else {
        await call.save(
          { step, responseMessages: responseMessagesForStep(step) },
          createPendingMessage,
        );
        initialResponseMessagesSaved = true;
      }
      return (streamTextArgs.onStepEnd ?? streamTextArgs.onStepFinish)?.(step);
    },
  } as Parameters<
    typeof streamTextAi<Tools, RUNTIME_CONTEXT, OUTPUT>
  >[0]) as StreamTextResult<Tools, RUNTIME_CONTEXT, OUTPUT>;
  const stream = streamer?.consumeStream(
    result.toUIMessageStream<AIUIMessage<Tools>>({
      sendSources:
        typeof options.saveStreamDeltas === "object"
          ? (options.saveStreamDeltas.sendSources ??
            DEFAULT_STREAMING_OPTIONS.sendSources)
          : DEFAULT_STREAMING_OPTIONS.sendSources,
    }),
  );
  if (willAwaitStream) {
    try {
      await stream;
      await result.consumeStream();
    } catch (e) {
      // If the stream errored (e.g. onStepFinish threw), the DeltaStreamer's
      // finish() was never called, leaving the streaming message stuck in
      // "streaming" state. Clean it up by marking it as aborted.
      try {
        await streamer?.fail(errorToString(e));
      } catch (cleanupError) {
        streamCleanupFailure ??= { error: cleanupError };
      }
      if (pendingFinalStep) {
        try {
          await call.save(pendingFinalStep, false);
        } catch (saveError) {
          console.error("Failed to save deferred final step:", saveError);
        }
        pendingFinalStep = undefined;
      }
      throw e;
    }
  } else {
    // The caller consumes the provider stream, but this separate background
    // consumer can still reject (e.g. if durable abort cleanup fails).
    void stream?.catch((error) => {
      console.error("Failed to persist stream deltas:", error);
    });
  }

  if (streamCleanupFailure) throw streamCleanupFailure.error;

  // If we deferred the final step save, do it now with atomic stream finish.
  if (pendingFinalStep && streamer) {
    const finishStreamId = await streamer.getOrCreateStreamId({
      ifAborted: "returnUndefined",
    });
    if (finishStreamId) {
      await call.save(pendingFinalStep, false, finishStreamId);
    }
    pendingFinalStep = undefined;
  } else if (willAwaitStream && streamer) {
    // No final step was deferred (e.g. the generation produced none), so no
    // save will finish the stream. The streamer doesn't finish itself, so do
    // it here rather than leaving the row to time out.
    await streamer.finish();
  }
  const metadata: GenerationOutputMetadata = {
    promptMessageId,
    order,
    savedMessages: call.getSavedMessages(),
    messageId: promptMessageId,
  };
  return Object.assign(result, metadata);
}
