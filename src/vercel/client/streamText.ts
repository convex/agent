import type {
  StreamTextResult,
  StreamTextTransform,
  TextStreamPart,
  ToolSet,
  UIMessageChunk,
} from "ai";
import type { Context } from "@ai-sdk/provider-utils";
import { streamText as streamTextAi, toUIMessageChunk } from "ai";
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
import { errorToString } from "./utils.js";
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
    >(
      ctx,
      component,
      streamTextArgs,
      { ...options, endsFromHooks: true },
      "streamText",
    );

  const savesMessages = options?.storageOptions?.saveMessages !== "none";
  const willAwaitStream =
    Boolean(threadId) &&
    (options.saveStreamDeltas === true ||
      (typeof options.saveStreamDeltas === "object" &&
        !options.saveStreamDeltas.returnImmediately));

  // Why the deltas stopped, for the failure it causes: stopped deltas abort
  // the AI SDK, which ends the generation where it stops. Failing the
  // streamer because the generation failed doesn't.
  let deltasFailed: string | undefined;
  const deltasStopped = new AbortController();
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
            onAsyncAbort: async (reason) => {
              deltasFailed ??= reason;
              deltasStopped.abort();
            },
            compress: compressUIMessageChunks,
            materialize: (parts) =>
              materializeUIMessageChunkFiles(ctx, component, parts),
            // The stream ends with the generation, after the parts the AI SDK
            // still delivers once aborted.
            abortSignal: undefined,
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

  const sendSources =
    typeof options.saveStreamDeltas === "object"
      ? (options.saveStreamDeltas.sendSources ??
        DEFAULT_STREAMING_OPTIONS.sendSources)
      : DEFAULT_STREAMING_OPTIONS.sendSources;
  const onWriteError = (error: unknown) => {
    deltasFailed ??= errorToString(error);
    deltasStopped.abort();
  };
  // Written where the generation ends, so it ends after the last of them.
  // Parts reach the streamer one at a time, so while the stream is created
  // the first part waits alone, as it did for a reader awaiting each part,
  // until the generation's end hands over the rest at once.
  const unwritten: UIMessageChunk[] = [];
  let writing = false;
  let wroteAny = false;
  const writeInOrder = async () => {
    writing = true;
    try {
      while (unwritten.length > 0) {
        await streamer?.addParts(unwritten.splice(0, 1));
      }
    } catch (error) {
      onWriteError(error);
    } finally {
      writing = false;
    }
  };
  const write = (part: TextStreamPart<Tools>) => {
    const chunk =
      streamer && toUIMessageChunk(part, { tools: args.tools, sendSources });
    if (!chunk) return;
    // A generation aborted before its first part has no stream.
    if (!wroteAny && args.abortSignal?.aborted) return;
    wroteAny = true;
    unwritten.push(chunk);
    if (!writing) void writeInOrder();
  };
  const writeRest = () => {
    if (unwritten.length === 0) return;
    streamer?.addParts(unwritten.splice(0)).catch(onWriteError);
  };
  // What was written is read back into the failed message.
  const failGeneration = async (
    reason: string,
    onAbort?: () => PromiseLike<void> | void,
  ) => {
    writeRest();
    await streamer?.flushAndStopAccepting().catch(() => {});
    await runStreamCleanup({
      failCall: () => call.fail(reason),
      failStreamer: async () => streamer?.fail(reason),
      onAbort,
    });
  };
  const endGeneration = (options?: Parameters<typeof call.end>[0]) =>
    call.end(options).catch(async (error) => {
      await streamer?.fail(errorToString(error)).catch(() => {});
      throw error;
    });
  let stepError: string | undefined;
  let finished = false;
  let stopped = false;
  let aborted: { onAbort: () => PromiseLike<void> | void } | undefined;
  // The caller's onAbort runs once, wherever the aborted generation ends.
  const onAbortOnce = () => {
    const onAbort = aborted?.onAbort;
    if (aborted) aborted.onAbort = () => {};
    return onAbort?.();
  };
  let abortFailure: { error: unknown } | undefined;
  const transforms = mergeTransforms(
    options?.saveStreamDeltas,
    streamTextArgs.experimental_transform,
  ).map(
    (transform): StreamTextTransform<Tools> =>
      (transformOptions) =>
        transform({
          ...transformOptions,
          stopStream: () => {
            stopped = true;
            transformOptions.stopStream();
          },
        }),
  );
  // At `finish`, after the last onStepEnd, the last step is saved and its
  // stream finished before passing it on.
  const endAtFinish = async (part?: TextStreamPart<Tools>) => {
    finished = true;
    if (stepError !== undefined) await failGeneration(stepError);
    else if (savesMessages) {
      writeRest();
      await streamer?.flushAndStopAccepting();
      const writeFailed = streamer?.abortController.signal.aborted;
      await endGeneration({
        finishStreamId: writeFailed ? undefined : streamer?.streamId,
      });
      // A failed last write aborted the stream, which the caller sees fail.
      if (writeFailed) {
        await streamer
          ?.fail(deltasFailed ?? "The last delta failed")
          .catch((error) => {
            abortFailure ??= { error };
          });
      }
    } else {
      if (part) write(part);
      writeRest();
      await endGeneration();
      await streamer?.finish();
    }
  };
  // The generation ends where its stream does, before the result resolves,
  // after every part before it is written. A stream that ends without
  // `finish` was aborted, or cut its step off on an error part (one the SDK
  // did not retry) or because a transform stopped it. It ends without any of
  // them between retries, and where a transform drops `finish`.
  const saveLastStep: StreamTextTransform<Tools> = () => {
    let errorPart: { error: unknown } | undefined;
    let error: string | undefined;
    return new TransformStream<TextStreamPart<Tools>, TextStreamPart<Tools>>({
      async transform(part, controller) {
        if (part.type === "error") {
          errorPart = part;
          error = errorToString(part.error);
        }
        if (part.type === "finish-step") {
          stepError =
            error ??
            (part.finishReason === "error"
              ? "The generation failed"
              : undefined);
        }
        if (part.type === "finish") {
          await endAtFinish(part);
        } else if (part.type !== "abort") {
          // The stream's status says it was aborted.
          write(part);
        }
        controller.enqueue(part);
      },
      flush: async () => {
        if (aborted) {
          const reason =
            deltasFailed ??
            (args.abortSignal?.reason
              ? errorToString(args.abortSignal.reason)
              : "streamText aborted");
          // The caller's stream ends on the abort, as the AI SDK ends it.
          await failGeneration(reason, onAbortOnce).catch((error) => {
            abortFailure = { error };
          });
          return;
        }
        if (!finished && (error !== undefined || stopped)) {
          finished = true;
          await failGeneration(
            error ?? "The generation stopped before its step ended",
          ).catch((cleanupError) => {
            // An error the stream has already carried isn't thrown again.
            if (cleanupError !== errorPart?.error) throw cleanupError;
          });
        }
      },
    });
  };

  const result = streamTextAi<Tools, RUNTIME_CONTEXT, OUTPUT>({
    ...args,
    abortSignal: streamer
      ? AbortSignal.any(
          args.abortSignal
            ? [args.abortSignal, deltasStopped.signal]
            : [deltasStopped.signal],
        )
      : args.abortSignal,
    experimental_transform: [...transforms, saveLastStep],
    // Ended in saveLastStep's flush, after the parts the abort releases.
    onAbort: (event) => {
      aborted = { onAbort: () => streamTextArgs.onAbort?.(event) };
    },
    prepareStep: async (options) => {
      await call.beforeStep(options);
      const result = await streamTextArgs.prepareStep?.(options);
      if (result) {
        const model = result.model ?? options.model;
        call.updateModel(model);
        return result;
      }
      return undefined;
    },
    onStepEnd: async (step) => {
      await call.endStep(step, stepError);
      return (streamTextArgs.onStepEnd ?? streamTextArgs.onStepFinish)?.(step);
    },
    onEnd: async (event) => {
      // Without `finish`, which a transform dropped, it ends here.
      await (finished ? endGeneration() : endAtFinish());
      return (streamTextArgs.onEnd ?? streamTextArgs.onFinish)?.(event);
    },
  } as Parameters<
    typeof streamTextAi<Tools, RUNTIME_CONTEXT, OUTPUT>
  >[0]) as StreamTextResult<Tools, RUNTIME_CONTEXT, OUTPUT>;
  // The generation runs to its end whoever reads the stream.
  let streamError: { error: unknown } | undefined;
  const ended = Promise.resolve(
    result.consumeStream({
      onError: (e) => {
        streamError ??= { error: e };
      },
    }),
  ).then(async () => {
    if (abortFailure) throw abortFailure.error;
    if (streamError) {
      await failGeneration(errorToString(streamError.error), onAbortOnce);
    }
    await endGeneration();
  });
  // Unless the caller awaits it, a failure to save is only reported.
  void ended.catch((error) => {
    if (!willAwaitStream) {
      console.error("Failed to persist stream deltas:", error);
    }
  });
  if (willAwaitStream) {
    await ended;
    if (streamError) throw streamError.error;
  }

  const metadata: GenerationOutputMetadata = {
    promptMessageId,
    order,
    savedMessages: call.getSavedMessages(),
    messageId: promptMessageId,
  };
  return Object.assign(result, metadata);
}
