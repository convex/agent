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
            pendingMessageId: call.pendingMessageId,
          },
        )
      : undefined;

  const transforms = mergeTransforms(
    options?.saveStreamDeltas,
    streamTextArgs.experimental_transform,
  );
  // The SDK passes `finish` on only after the last onStepEnd, and its results
  // resolve after it, so the last step is saved here. It passes on only the
  // errors it won't retry, and recreates transforms for each retry, so an
  // error and then the end of this segment without `finish` (e.g. a rejected
  // request) ends the generation. A stream ended without either (e.g.
  // stopStream) still saves its step. An error in an earlier transform, or
  // the reader cancelling, skips flush and runs cancel, which TypeScript's DOM
  // types don't list yet.
  const saveLastStep: StreamTextTransform<Tools> = () => {
    let error: string | undefined;
    let finished = false;
    return new TransformStream({
      cancel: (reason: unknown) =>
        call.fail(errorToString(reason ?? "The stream was cancelled")),
      async transform(part, controller) {
        if (part.type === "error") error = errorToString(part.error);
        if (part.type === "finish") {
          finished = true;
          await call.end({
            error:
              part.finishReason === "error"
                ? (error ?? "The generation failed")
                : undefined,
            streamId: streamer?.streamId,
          });
        }
        controller.enqueue(part);
      },
      flush: async () => {
        if (finished) return;
        if (error !== undefined) await call.fail(error);
        await call.end({ streamId: streamer?.streamId });
      },
    } as Transformer<TextStreamPart<Tools>, TextStreamPart<Tools>>);
  };

  const result = streamTextAi<Tools, RUNTIME_CONTEXT, OUTPUT>({
    ...args,
    abortSignal: streamer?.abortController.signal ?? args.abortSignal,
    experimental_transform: [
      ...(Array.isArray(transforms)
        ? transforms
        : transforms
          ? [transforms]
          : []),
      saveLastStep,
    ],
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
      await call.beforeStep(options, streamer?.streamId);
      const result = await streamTextArgs.prepareStep?.(options);
      if (result) {
        const model = result.model ?? options.model;
        call.updateModel(model);
        return result;
      }
      return undefined;
    },
    onStepEnd: (step) => {
      call.endStep(step);
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
      // If the stream errored (e.g. a transform threw), the DeltaStreamer
      // never finished, leaving the streaming message stuck and the
      // generation unfinished.
      await runStreamCleanup({
        failCall: () => call.fail(errorToString(e)),
        failStreamer: async () => streamer?.fail(errorToString(e)),
      }).catch(() => {});
      throw e;
    }
    await call.end();
  } else {
    // The caller consumes the provider stream, but this separate background
    // consumer can still reject (e.g. if durable abort cleanup fails, or the
    // stream errored).
    void stream?.catch(async (error) => {
      console.error("Failed to persist stream deltas:", error);
      await call.fail(errorToString(error)).catch(() => {});
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
