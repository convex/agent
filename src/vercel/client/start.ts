import {
  isStepCount,
  type GenerateObjectResult,
  type IdGenerator,
  type Instructions,
  type ModelMessage,
  type StepResult,
  type StopCondition,
  type ToolSet,
} from "ai";
import type { Context } from "@ai-sdk/provider-utils";
import {
  serializeResponseMessages,
  serializeObjectResult,
} from "../mapping.js";
import { embedMessages, fetchContextWithPrompt } from "./search.js";
import type {
  ActionCtx,
  AgentCallSettings,
  AgentComponent,
  AgentLanguageModel,
  Config,
  Options,
} from "./types.js";
import type { Message, MessageDoc } from "../../validators.js";
import {
  getModelName,
  getProviderName,
  type ModelOrMetadata,
} from "../../shared.js";
import { wrapTools, type ToolCtx } from "./createTool.js";
import type { Agent } from "../index.js";
import { assert, omit } from "convex-helpers";
import { saveInputMessages } from "./saveInputMessages.js";
import type { GenericActionCtx, GenericDataModel } from "convex/server";

export function resolveUsageModel(
  toSave:
    | { step: { model?: ModelOrMetadata } }
    | { object: unknown },
  activeModel: ModelOrMetadata,
): ModelOrMetadata {
  return "step" in toSave ? (toSave.step.model ?? activeModel) : activeModel;
}

type RawRequestResponseInclude = Record<string, boolean>;

/**
 * The raw handler promises request and, for non-streaming calls, response
 * bodies. Preserve explicit caller choices while opting in to those bodies.
 */
function rawRequestResponseInclude(
  args: {
    experimental_include?: RawRequestResponseInclude;
    include?: RawRequestResponseInclude;
  },
  enabled: boolean,
  operation:
    | "generateText"
    | "streamText"
    | "generateObject"
    | "streamObject"
    | undefined,
): RawRequestResponseInclude | undefined {
  if (!enabled) return undefined;

  const requested = {
    ...args.experimental_include,
    ...args.include,
  };
  return {
    ...requested,
    requestBody: requested.requestBody ?? true,
    ...((operation === "generateText" || operation === "generateObject")
      ? { responseBody: requested.responseBody ?? true }
      : {}),
  };
}

export async function startGeneration<
  T,
  Tools extends ToolSet = ToolSet,
  CustomCtx extends object = object,
  RUNTIME_CONTEXT extends Context = Context,
>(
  ctx: ActionCtx & CustomCtx,
  component: AgentComponent,
  /**
   * These are the arguments you'll pass to the LLM call such as
   * `generateText` or `streamText`. This function will look up the context
   * and provide functions to save the steps, abort the generation, and more.
   * The type of the arguments returned infers from the type of the arguments
   * you pass here.
   */
  args: T & {
    /**
     * If provided, this message will be used as the "prompt" for the LLM call,
     * instead of the prompt or messages.
     * This is useful if you want to first save a user message, then use it as
     * the prompt for the LLM call in another call.
     */
    promptMessageId?: string;
    /**
     * The model to use for the LLM calls. This will override the model specified
     * in the Agent constructor.
     */
    model?: AgentLanguageModel;
    /**
     * The tools to use for the tool calls. This will override tools specified
     * in the Agent constructor or createThread / continueThread.
     */
    tools?: Tools;
    /**
     * The single prompt message to use for the LLM call. This will be the
     * last message in the context. If it's a string, it will be a user role.
     */
    prompt?: string | (ModelMessage | Message)[];
    /**
     * If provided alongside prompt, the ordering will be:
     * 1. system prompt
     * 2. search context
     * 3. recent messages
     * 4. these messages
     * 5. prompt messages, including those already on the same `order` as
     *   the promptMessageId message, if provided.
     */
    messages?: (ModelMessage | Message)[];
    instructions?: Instructions;
    /** @deprecated Use instructions. */
    system?: Instructions;
    allowSystemInMessages?: boolean;
    /**
     * The abort signal to be passed to the LLM call. If triggered, it will
     * mark the pending message as failed. If the generation is asynchronously
     * aborted, it will trigger this signal when detected.
     */
    abortSignal?: AbortSignal;
    runtimeContext?: RUNTIME_CONTEXT;
    stopWhen?:
      | StopCondition<Tools, RUNTIME_CONTEXT>
      | Array<StopCondition<Tools, RUNTIME_CONTEXT>>;
    _internal?: { generateId?: IdGenerator };
  },
  {
    threadId,
    ...opts
  }: Options &
    Config & {
      userId?: string | null;
      threadId?: string;
      agentName: string;
      agentForToolCtx?: Agent;
    },
  _operation?:
    | "generateText"
    | "streamText"
    | "generateObject"
    | "streamObject",
): Promise<{
  args: Omit<T, "model"> & {
    instructions?: Instructions;
    model: AgentLanguageModel;
    messages: ModelMessage[];
    prompt?: never;
    tools?: Tools;
    runtimeContext?: RUNTIME_CONTEXT;
  } & AgentCallSettings;
  order: number;
  stepOrder: number;
  userId: string | undefined;
  promptMessageId: string | undefined;
  updateModel: (model: ModelOrMetadata | undefined) => void;
  save: <TOOLS extends ToolSet>(
    toSave:
      | {
          step: StepResult<TOOLS, RUNTIME_CONTEXT>;
          responseMessages?: ModelMessage[];
        }
      | { object: GenerateObjectResult<unknown> },
    createPendingMessage?: boolean,
    finishStreamId?: string,
  ) => Promise<void>;
  fail: (reason: string) => Promise<void>;
  getSavedMessages: () => MessageDoc[];
}> {
  const userId =
    opts.userId ??
    (threadId &&
      (await ctx.runQuery(component.threads.getThread, { threadId }))
        ?.userId) ??
    undefined;

  const context = await fetchContextWithPrompt(ctx, component, {
    ...opts,
    userId,
    threadId,
    messages: args.messages,
    prompt: args.prompt,
    promptMessageId: args.promptMessageId,
  });
  const allowSystemInMessages = args.allowSystemInMessages ?? true;
  if (
    !allowSystemInMessages &&
    context.messages.some((message) => message.role === "system")
  ) {
    throw new Error(
      "System messages in assembled message history require allowSystemInMessages: true. Use instructions for top-level system guidance.",
    );
  }

  const saveMessages = opts.storageOptions?.saveMessages ?? "promptAndOutput";
  const { promptMessageId, pendingMessage, savedMessages } =
    threadId && saveMessages !== "none"
      ? await saveInputMessages(ctx, component, {
          ...opts,
          userId,
          threadId,
          prompt: args.prompt,
          messages: args.messages,
          promptMessageId: args.promptMessageId,
          storageOptions: { saveMessages },
        })
      : {
          promptMessageId: args.promptMessageId,
          pendingMessage: undefined,
          savedMessages: [] as MessageDoc[],
        };

  const order = pendingMessage?.order ?? context.order;
  const stepOrder = pendingMessage?.stepOrder ?? context.stepOrder;
  let pendingMessageId = pendingMessage?._id;

  const model = args.model ?? opts.languageModel;
  assert(model, "model is required");
  let activeModel: ModelOrMetadata = model;

  // Both the caller's AbortSignal listener and AI SDK's onAbort can report
  // the same cancellation. Share the one finalization instead of racing two
  // mutations for the pending message.
  let pendingMessageFailure: Promise<void> | undefined;
  const fail = (reason: string): Promise<void> => {
    if (!pendingMessageId) return Promise.resolve();
    if (!pendingMessageFailure) {
      const messageId = pendingMessageId;
      pendingMessageFailure = ctx
        .runMutation(component.messages.finalizeMessage, {
          messageId,
          result: { status: "failed", error: reason },
        })
        .then(() => undefined);
    }
    return pendingMessageFailure;
  };
  if (args.abortSignal) {
    const abortSignal = args.abortSignal;
    abortSignal.addEventListener(
      "abort",
      async () => {
        await fail(abortSignal.reason?.toString() ?? "abortSignal");
      },
      { once: true },
    );
  }
  const toolCtx = {
    ...(ctx as GenericActionCtx<GenericDataModel> & CustomCtx),
    userId,
    threadId,
    promptMessageId,
    agent: opts.agentForToolCtx,
  } satisfies ToolCtx;
  const tools = wrapTools(toolCtx, args.tools) as Tools;
  const argsWithoutSystem = omit(
    args as typeof args & { system?: Instructions },
    ["system"],
  );
  const {
    promptMessageId: _promptMessageId,
    messages: _messages,
    prompt: _prompt,
    instructions: _instructions,
    onStepFinish: _onStepFinish,
    ...aiCallArgs
  } = argsWithoutSystem as typeof argsWithoutSystem & {
    onStepFinish?: unknown;
  };
  const include = rawRequestResponseInclude(
    aiCallArgs as {
      experimental_include?: RawRequestResponseInclude;
      include?: RawRequestResponseInclude;
    },
    Boolean(opts.rawRequestResponseHandler),
    _operation,
  );
  const aiArgs = {
    ...opts.callSettings,
    providerOptions: opts.providerOptions,
    ...aiCallArgs,
    model,
    messages: context.messages,
    instructions: args.instructions ?? args.system,
    allowSystemInMessages,
    stopWhen:
      args.stopWhen ?? (opts.maxSteps ? isStepCount(opts.maxSteps) : undefined),
    tools,
    ...(include ? { include } : {}),
  } as unknown as Omit<T, "model"> & {
    model: AgentLanguageModel;
    messages: ModelMessage[];
    prompt?: never;
    tools?: Tools;
    _internal?: { generateId?: IdGenerator };
  } & AgentCallSettings;
  // NOTE: We intentionally do NOT override _internal.generateId here.
  // The AI SDK uses generateId() for many internal IDs (approval IDs,
  // tool execution IDs, message IDs, etc.) and they must be unique.
  // The pending message is linked via the explicit `pendingMessageId`
  // parameter passed to addMessages in the save closure.
  return {
    args: aiArgs,
    order: order ?? 0,
    stepOrder: stepOrder ?? 0,
    userId,
    promptMessageId,
    getSavedMessages: () => savedMessages,
    updateModel: (model: ModelOrMetadata | undefined) => {
      if (model) {
        activeModel = model;
      }
    },
    fail,
    save: async <TOOLS extends ToolSet>(
      toSave:
        | {
            step: StepResult<TOOLS, RUNTIME_CONTEXT>;
            responseMessages?: ModelMessage[];
          }
        | { object: GenerateObjectResult<unknown> },
      createPendingMessage?: boolean,
      /**
       * If provided, finish this stream atomically with the message save.
       * This prevents UI flickering from separate mutations (issue #181).
       */
      finishStreamId?: string,
    ) => {
      if (threadId && saveMessages !== "none") {
        let serialized;
        if ("object" in toSave) {
          serialized = await serializeObjectResult(
            ctx,
            component,
            toSave.object,
            activeModel,
          );
        } else {
          const newResponseMessages =
            toSave.responseMessages ?? toSave.step.response.messages;
          // Even an empty completed step needs a durable assistant result so
          // the pending message can be finalized at the storage boundary.
          const responseMessagesToSave: ModelMessage[] =
            newResponseMessages.length > 0
              ? newResponseMessages
              : [{ role: "assistant", content: [] }];
          serialized = await serializeResponseMessages(
            ctx,
            component,
            toSave.step,
            activeModel,
            responseMessagesToSave,
          );
        }
        const embeddings = await embedMessages(
          ctx,
          { threadId, ...opts, userId },
          serialized.messages.map((m) => m.message),
        );
        if (createPendingMessage) {
          serialized.messages.push({
            message: { role: "assistant", content: [] },
            status: "pending",
          });
          embeddings?.vectors.push(null);
        }
        const saved = await ctx.runMutation(component.messages.addMessages, {
          userId,
          threadId,
          agentName: opts.agentName,
          promptMessageId,
          abandonIfPromptMissing: true,
          pendingMessageId,
          messages: serialized.messages,
          embeddings,
          failPendingSteps: false,
          finishStreamId,
        });
        const lastMessage = saved.messages.at(-1)!;
        if (createPendingMessage) {
          if (lastMessage.status === "failed") {
            pendingMessageId = undefined;
            savedMessages.push(...saved.messages);
            await fail(
              lastMessage.error ??
                "Aborting - the pending message was marked as failed",
            );
          } else {
            pendingMessageId = lastMessage._id;
            pendingMessageFailure = undefined;
            savedMessages.push(...saved.messages.slice(0, -1));
          }
        } else {
          pendingMessageId = undefined;
          savedMessages.push(...saved.messages);
        }
      }
      const output = "object" in toSave ? toSave.object : toSave.step;
      if (opts.rawRequestResponseHandler) {
        await opts.rawRequestResponseHandler(ctx, {
          userId,
          threadId,
          agentName: opts.agentName,
          request: output.request,
          response: output.response,
        });
      }
      if (opts.usageHandler && output.usage) {
        const usageModel = resolveUsageModel(toSave, activeModel);
        await opts.usageHandler(ctx, {
          userId,
          threadId,
          agentName: opts.agentName,
          model: getModelName(usageModel),
          provider: getProviderName(usageModel),
          usage: output.usage,
          providerMetadata: output.providerMetadata,
        });
      }
    },
  };
}
