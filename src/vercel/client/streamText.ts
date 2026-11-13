import type {
  StreamTextResult,
  StreamTextTransform,
  TextStreamPart,
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
    >(ctx, component, streamTextArgs, options, "streamText");

  const savesMessages = options?.storageOptions?.saveMessages !== "none";
  const willAwaitStream =
    Boolean(threadId) &&
    (options.saveStreamDeltas === true ||
      (typeof options.saveStreamDeltas === "object" &&
        !options.saveStreamDeltas.returnImmediately));

  // Why the deltas stopped, for the failure it causes: the streamer aborts the
  // AI SDK, which ends the generation where it stops.
  let deltasFailed: string | undefined;
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
            },
            compress: compressUIMessageChunks,
            materialize: (parts) =>
              materializeUIMessageChunkFiles(ctx, component, parts),
            abortSignal: args.abortSignal,
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

  const failGeneration = (reason: string) =>
    runStreamCleanup({
      failCall: () => call.fail(reason),
      failStreamer: async () => streamer?.fail(reason),
    });
  const endGeneration = (options?: Parameters<typeof call.end>[0]) =>
    call.end(options).catch(async (error) => {
      await streamer?.fail(errorToString(error)).catch(() => {});
      throw error;
    });
  let stepError: string | undefined;
  let finished = false;
  let stopped = false;
  let stepEnds = 0;
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
  // The generation ends where its stream does, before the result resolves:
  // at `finish`, after the last onStepEnd, the last step is saved and its
  // stream finished before passing it on. A stream that ends without `finish`
  // on an error part (one the SDK did not retry), or because a transform
  // stopped it, cut its step off. It ends without either between retries.
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
          stepEnds++;
          stepError =
            error ??
            (part.finishReason === "error"
              ? "The generation failed"
              : undefined);
        }
        if (part.type === "finish") {
          finished = true;
          if (stepError !== undefined) await failGeneration(stepError);
          else {
            await endGeneration({
              finishStreamId: savesMessages
                ? await streamer?.handOver(stepEnds)
                : undefined,
            });
          }
        }
        controller.enqueue(part);
      },
      flush: async () => {
        if (!finished && (error !== undefined || stopped)) {
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
    abortSignal: streamer?.abortController.signal ?? args.abortSignal,
    experimental_transform: [...transforms, saveLastStep],
    onAbort: async (event) => {
      const reason =
        deltasFailed ??
        (args.abortSignal?.reason
          ? errorToString(args.abortSignal.reason)
          : "streamText aborted");
      await runStreamCleanup({
        failCall: () => call.fail(reason),
        failStreamer: async () => streamer?.fail(reason),
        onAbort: () => streamTextArgs.onAbort?.(event),
      });
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
      await endGeneration();
      return (streamTextArgs.onEnd ?? streamTextArgs.onFinish)?.(event);
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
  // The generation runs to its end whoever reads the stream.
  let streamError: { error: unknown } | undefined;
  const ended = Promise.resolve(
    result.consumeStream({
      onError: (e) => {
        streamError ??= { error: e };
      },
    }),
  ).then(async () => {
    if (streamError) await failGeneration(errorToString(streamError.error));
    await endGeneration();
  });
  void ended.catch(() => {});
  if (willAwaitStream) {
    try {
      await stream;
    } catch (e) {
      await failGeneration(errorToString(e)).catch(() => {});
      throw e;
    }
    await ended;
  } else {
    // The caller consumes the provider stream, but this separate background
    // consumer can still reject (e.g. if durable abort cleanup fails, or the
    // stream errored).
    void stream?.catch((error) => {
      console.error("Failed to persist stream deltas:", error);
      deltasFailed ??= errorToString(error);
    });
  }

  const metadata: GenerationOutputMetadata = {
    promptMessageId,
    order,
    savedMessages: call.getSavedMessages(),
    messageId: promptMessageId,
  };
  return Object.assign(result, metadata);
}
