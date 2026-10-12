import type { StreamTextResult, ToolSet, UIMessage as AIUIMessage } from "ai";
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
import { getGenerationControls, startGeneration } from "./start.js";
import type { Agent } from "../index.js";
import { getModelName, getProviderName } from "../../shared.js";
import { errorToString } from "./utils.js";
import { StepLifecycle } from "./stepLifecycle.js";
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
  const started = await startGeneration<
    StreamingTextArgs<AgentTools, TOOLS, OUTPUT, RUNTIME_CONTEXT>,
    Tools,
    object,
    RUNTIME_CONTEXT
  >(ctx, component, streamTextArgs, options, "streamText");
  const { args, userId, order, stepOrder, promptMessageId, ...call } = started;

  // The AI SDK calls onError before deciding whether to retry (ai 7.0.91+),
  // and while it still uses the abort signal, so failing the generation there
  // kills retries and aborts a live pipeline (issue #387). An error fails the
  // generation only if no step ends cleanly after it.
  let unrecoveredError: string | undefined;

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

  const lifecycle = new StepLifecycle<Tools, RUNTIME_CONTEXT>(
    getGenerationControls(started),
    {
      streamed: Boolean(threadId && options.saveStreamDeltas),
      // Only the awaited path has a caller to throw a save failure to.
      onSaveFailure: willAwaitStream
        ? undefined
        : (error) => console.error("Failed to save a generation step:", error),
    },
  );

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

  // Only called once the AI SDK has finished, so the signal it owns is left
  // alone (issue #387); aborting it is for cancellation.
  let generationFailure: Promise<void> | undefined;
  const failGeneration = (reason: string) =>
    (generationFailure ??= runStreamCleanup({
      failCall: () => call.fail(reason),
      failStreamer: async () =>
        streamer?.fail(reason, { abortGeneration: false }),
    }));

  // Saves the step the generation ended on, finishing the row with it
  // (#181). The save stores the messages before running the handlers, so a
  // failure here means nothing was stored: the message is still pending and
  // the row streaming, and those are failed here.
  const finalize = async () => {
    let finishStreamId: string | undefined;
    if (streamer) {
      if (!willAwaitStream) await streamer.flushAndStopAccepting();
      finishStreamId = await streamer.getOrCreateStreamId({
        ifAborted: "returnUndefined",
      });
      if (!finishStreamId) return;
    }
    try {
      const saved = await lifecycle.finalize(finishStreamId);
      // Without stored messages the save finishes nothing, and on the awaited
      // path consumeStream finishes the row instead.
      const ownsFinish =
        Boolean(streamer) && (savesMessages ? !saved : !willAwaitStream);
      if (ownsFinish) await streamer!.finish();
    } catch (error) {
      await failGeneration(errorToString(error));
      throw error;
    }
  };

  let callerOnEnd: (() => unknown) | undefined;
  const end = async () => {
    if (unrecoveredError !== undefined) {
      await failGeneration(unrecoveredError);
    } else {
      await finalize();
    }
  };

  const result = streamTextAi<Tools, RUNTIME_CONTEXT, OUTPUT>({
    ...args,
    abortSignal: streamer?.abortController.signal ?? args.abortSignal,
    experimental_transform: mergeTransforms(
      options?.saveStreamDeltas,
      streamTextArgs.experimental_transform,
    ),
    onError: async (error) => {
      console.error("onError", error);
      unrecoveredError = errorToString(error.error);
      return streamTextArgs.onError?.(error);
    },
    onAbort: async (event) => {
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
      await lifecycle.stepStarting(options);
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
      lifecycle.stepEnded(step);
      if (step.finishReason !== "error") unrecoveredError = undefined;
      return (streamTextArgs.onStepEnd ?? streamTextArgs.onStepFinish)?.(step);
    },
    // With nothing awaiting consumption, this is the last point before the
    // caller's stream ends (#265). The awaited path ends at end of
    // consumption instead (#326), and the caller's onEnd waits for it.
    onEnd: async (event) => {
      const runCallerOnEnd = () =>
        (streamTextArgs.onEnd ?? streamTextArgs.onFinish)?.(event);
      if (willAwaitStream) {
        callerOnEnd = runCallerOnEnd;
      } else {
        await lifecycle.ended(end, runCallerOnEnd);
      }
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
  // A generation that recorded no step ends without onEnd.
  const noSteps = result.steps.then(
    () => false,
    () => true,
  );
  if (!willAwaitStream) {
    // The caller consumes the provider stream, but this separate background
    // consumer can still reject (e.g. if durable abort cleanup fails).
    void stream?.catch((error) => {
      console.error("Failed to persist stream deltas:", error);
    });
    void noSteps.then(async (failed) => {
      if (!failed) return;
      try {
        await failGeneration(unrecoveredError ?? "No output generated");
      } catch (error) {
        lifecycle.recordSaveFailure(error);
      }
    });
  }
  if (willAwaitStream) {
    try {
      await stream;
      await result.consumeStream();
    } catch (e) {
      // The stream itself failed, so nothing will finish the row or the
      // pending message.
      await failGeneration(errorToString(e)).catch((cleanupError) =>
        console.error("Failed to clean up errored stream:", cleanupError),
      );
      throw e;
    }
    // End of consumption is where the generation really ended and every part
    // has been handed over (#326).
    if (await noSteps) {
      await failGeneration(unrecoveredError ?? "No output generated");
    } else {
      await lifecycle.ended(end, () => callerOnEnd?.());
    }
    lifecycle.throwSaveFailure();
  }
  const metadata: GenerationOutputMetadata = {
    promptMessageId,
    order,
    savedMessages: call.getSavedMessages(),
    messageId: promptMessageId,
  };
  return Object.assign(result, metadata);
}
