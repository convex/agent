import type { JSONObject } from "@ai-sdk/provider";
import type {
  Context,
  Experimental_SandboxSession,
  ToolResultOutput,
} from "@ai-sdk/provider-utils";
import type {
  FlexibleSchema,
  ModelMessage,
  Tool,
  ToolExecutionOptions,
  ToolSet,
} from "ai";
import { tool } from "ai";
import type {
  FunctionReference,
  FunctionReturnType,
  GenericActionCtx,
  GenericDataModel,
  OptionalRestArgs,
} from "convex/server";
import type { ProviderOptions } from "../../validators.js";
import type { Agent } from "../index.js";

const MIGRATION_URL = "node_modules/@convex-dev/agent/MIGRATION.md";
const warnedDeprecations = new Set<string>();
function warnDeprecation(key: string, message: string) {
  if (!warnedDeprecations.has(key)) {
    warnedDeprecations.add(key);
    console.warn(`[@convex-dev/agent] ${message}\n  See: ${MIGRATION_URL}`);
  }
}

export type ToolCtx<DataModel extends GenericDataModel = GenericDataModel> =
  GenericActionCtx<DataModel> & {
    agent?: Agent;
    userId?: string;
    threadId?: string;
    promptMessageId?: string;
    /**
     * The message the call's step saves into. With the call's `toolCallId`,
     * `${messageId}:${toolCallId}` is a key that a durable generation's retry
     * keeps for the same call, e.g. for an idempotency key.
     */
    messageId?: string;
  };

/**
 * How a durable generation runs a tool, beyond its `execute`: read by the
 * generation, not part of the AI SDK's tool.
 */
export type DurableTool =
  /** Its one `ctx.runMutation` is recorded, for exactly once. */
  | { kind: "mutation" }
  /** Run again on a replay: it has nothing to record. */
  | { kind: "query" }
  /** Run for a call a crashed job started without recording a result. */
  | {
      kind: "execute";
      resume: (
        ctx: ToolCtx,
        input: any,
        options: ToolExecutionOptions<any>,
      ) => unknown;
    };
const DURABLE = Symbol.for("@convex-dev/agent/durableTool");
export const durableTool = (tool: unknown): DurableTool | undefined =>
  (tool as { [DURABLE]?: DurableTool } | undefined)?.[DURABLE];

export type AgentToolExecutionOptions<TOOL_CONTEXT extends Context = Context> =
  ToolExecutionOptions<TOOL_CONTEXT>;

/**
 * Function that is called to determine if the tool needs approval before it can be executed.
 */
export type ToolNeedsApprovalFunctionCtx<
  INPUT,
  Ctx extends ToolCtx = ToolCtx,
  TOOL_CONTEXT extends Context = Context,
> = (
  ctx: Ctx,
  input: INPUT,
  options: {
    /**
     * The ID of the tool call. You can use it e.g. when sending tool-call related information with stream data.
     */
    toolCallId: string;
    /**
     * Messages that were sent to the language model to initiate the response that contained the tool call.
     * The messages **do not** include the system prompt nor the assistant response that contained the tool call.
     */
    messages: ModelMessage[];
    /**
     * Additional context.
     *
     * Experimental (can break in patch releases).
     */
    context: TOOL_CONTEXT;
  },
) => boolean | PromiseLike<boolean>;

export type ToolExecuteFunctionCtx<
  INPUT,
  OUTPUT,
  Ctx extends ToolCtx = ToolCtx,
  TOOL_CONTEXT extends Context = Context,
> = (
  ctx: Ctx,
  input: INPUT,
  options: AgentToolExecutionOptions<TOOL_CONTEXT>,
) => AsyncIterable<OUTPUT> | PromiseLike<OUTPUT>;

/**
 * A mutation tool's ctx: its one `ctx.runMutation`, of an internal mutation,
 * is what a durable generation records. Its body runs again on a replay, so
 * it has no `runAction` or `scheduler`.
 */
export type MutationToolCtx<Ctx extends ToolCtx = ToolCtx> = Omit<
  Ctx,
  "runMutation" | "runAction" | "scheduler"
> & {
  runMutation<Mutation extends FunctionReference<"mutation", "internal">>(
    mutation: Mutation,
    ...args: OptionalRestArgs<Mutation>
  ): Promise<FunctionReturnType<Mutation>>;
};

/** A query tool's ctx: it runs again on a replay, so it can't write. */
export type QueryToolCtx<Ctx extends ToolCtx = ToolCtx> = Omit<
  Ctx,
  "runMutation" | "runAction" | "scheduler"
>;

const ONE_MUTATION =
  "A mutation tool runs one ctx.runMutation, the call a durable generation records.";
const READ_ONLY =
  "A query tool can't write: a durable generation's replay runs it again.";

type NeverOptional<N, T> = 0 extends 1 & N
  ? Partial<T>
  : [N] extends [never]
    ? Partial<Record<keyof T, undefined>>
    : T;

/**
 * Error message type for deprecated 'handler' property.
 * Using a string literal type causes TypeScript to show this message in errors.
 */
type HANDLER_REMOVED_ERROR =
  "⚠️ 'handler' was removed in @convex-dev/agent v0.6.0. Rename to 'execute'. See: node_modules/@convex-dev/agent/MIGRATION.md";

type ToolRunsOne<
  INPUT,
  OUTPUT,
  Ctx extends ToolCtx,
  TOOL_CONTEXT extends Context,
> =
  | {
      /**
       * An async function that is called with the arguments from the tool call and produces a result.
       * If `execute` is not provided, the tool will not be executed automatically.
       *
       * @param input - The input of the tool call.
       * @param options.abortSignal - A signal that can be used to abort the tool call.
       */
      execute: ToolExecuteFunctionCtx<INPUT, OUTPUT, Ctx, TOOL_CONTEXT>;
      /**
       * Run for a call that a crashed durable generation started without
       * recording its result, with the same `toolCallId`, in place of telling
       * the model its outcome is unknown: for a tool that's safe to run again,
       * such as an API that dedupes on an idempotency key.
       */
      resume?: ToolExecuteFunctionCtx<INPUT, OUTPUT, Ctx, TOOL_CONTEXT>;
      mutation?: never;
      query?: never;
    }
  | {
      execute?: never;
      resume?: never;
      mutation?: never;
      query?: never;
    }
  | {
      /**
       * Run the tool as one internal mutation, called with
       * `ctx.runMutation`. In a durable generation that call runs in a
       * transaction that records its result, so a retry after a crash
       * neither runs it again nor loses its result, and a step that can't be
       * recorded refuses the tool. A replay runs the body again, and the
       * call returns its recorded result. Take identity from `ctx`, never
       * from the input: the model chooses the input.
       *
       * On an Agent, or exported, annotate its return type, e.g.
       * `(ctx, input): Promise<Order> => ...`: without it the agent's type
       * depends on `internal`, which depends on the agent, and TypeScript
       * reports that it "implicitly has type 'any'" (TS7022).
       */
      mutation: (
        ctx: MutationToolCtx<Ctx>,
        input: INPUT,
        options: AgentToolExecutionOptions<TOOL_CONTEXT>,
      ) => PromiseLike<OUTPUT>;
      query?: never;
      execute?: never;
      resume?: never;
    }
  | {
      /**
       * Run the tool as reads, such as `ctx.runQuery` of an internal query.
       * A durable generation's replay runs it again. Annotate its return
       * type as for `mutation`.
       */
      query: (
        ctx: QueryToolCtx<Ctx>,
        input: INPUT,
        options: AgentToolExecutionOptions<TOOL_CONTEXT>,
      ) => PromiseLike<OUTPUT>;
      mutation?: never;
      execute?: never;
      resume?: never;
    };

export type ToolOutputPropertiesCtx<
  INPUT,
  OUTPUT,
  Ctx extends ToolCtx = ToolCtx,
  TOOL_CONTEXT extends Context = Context,
> = NeverOptional<
  OUTPUT,
  ToolRunsOne<INPUT, OUTPUT, Ctx, TOOL_CONTEXT> & {
    outputSchema?: FlexibleSchema<OUTPUT>;
    /**
     * @deprecated Removed in v0.6.0. Use `execute` instead.
     */
    handler?: HANDLER_REMOVED_ERROR;
  }
>;

/**
 * Error message type for deprecated 'args' property.
 * Using a string literal type causes TypeScript to show this message in errors.
 */
type ARGS_REMOVED_ERROR =
  "⚠️ 'args' was removed in @convex-dev/agent v0.6.0. Rename to 'inputSchema'. See: node_modules/@convex-dev/agent/MIGRATION.md";

export type ToolInputProperties<INPUT> = {
  /**
   * The schema of the input that the tool expects.
   * The language model will use this to generate the input.
   * It is also used to validate the output of the language model.
   *
   * You can use descriptions on the schema properties to make the input understandable for the language model.
   */
  inputSchema: FlexibleSchema<INPUT>;
  /**
   * @deprecated Removed in v0.6.0. Use `inputSchema` instead.
   */
  args?: ARGS_REMOVED_ERROR;
};

/**
 * This is a wrapper around the ai.tool function that adds extra context to the
 * tool call, including the action context, userId, threadId, and promptMessageId.
 * @param tool The tool. See https://sdk.vercel.ai/docs/ai-sdk-core/tools-and-tool-calling
 * Currently contains deprecated parameters `args` and `handler` to maintain backwards compatibility
 * but these will be removed in the future. Use `inputSchema` and `execute` instead, respectively.
 *
 * @returns A tool to be used with the AI SDK.
 */
export function createTool<
  INPUT,
  OUTPUT,
  Ctx extends ToolCtx = ToolCtx,
  TOOL_CONTEXT extends Context = Context,
>(
  def: {
    /**
     * An optional description of what the tool does.
     * Will be used by the language model to decide whether to use the tool.
     * Not used for provider-defined tools.
     */
    description?:
      | string
      | ((options: {
          context: NoInfer<TOOL_CONTEXT>;
          experimental_sandbox?: Experimental_SandboxSession;
        }) => string);
    /**
     * An optional title of the tool.
     */
    title?: string;
    /**
     * Additional provider-specific metadata. They are passed through
     * to the provider from the AI SDK and enable provider-specific
     * functionality that can be fully encapsulated in the provider.
     */
    providerOptions?: ProviderOptions;
    metadata?: JSONObject;
    contextSchema?: FlexibleSchema<TOOL_CONTEXT>;
  } & ToolInputProperties<INPUT> & {
      /**
       * An optional list of input examples that show the language
       * model what the input should look like.
       */
      inputExamples?: Array<{
        input: NoInfer<INPUT>;
      }>;
      /**
       * Whether the tool needs approval before it can be executed.
       */
      needsApproval?:
        | boolean
        | ToolNeedsApprovalFunctionCtx<
            [INPUT] extends [never] ? unknown : INPUT,
            Ctx,
            TOOL_CONTEXT
          >;
      /**
       * Strict mode setting for the tool.
       *
       * Providers that support strict mode will use this setting to determine
       * how the input should be generated. Strict mode will always produce
       * valid inputs, but it might limit what input schemas are supported.
       */
      strict?: boolean;
      /**
       * Provide the context to use, e.g. when defining the tool at runtime.
       */
      ctx?: Ctx;
      /**
       * Optional function that is called when the argument streaming starts.
       * Only called when the tool is used in a streaming context.
       */
      onInputStart?: (
        ctx: Ctx,
        options: AgentToolExecutionOptions<TOOL_CONTEXT>,
      ) => void | PromiseLike<void>;
      /**
       * Optional function that is called when an argument streaming delta is available.
       * Only called when the tool is used in a streaming context.
       */
      onInputDelta?: (
        ctx: Ctx,
        options: {
          inputTextDelta: string;
        } & AgentToolExecutionOptions<TOOL_CONTEXT>,
      ) => void | PromiseLike<void>;
      /**
       * Optional function that is called when a tool call can be started,
       * even if the execute function is not provided.
       */
      onInputAvailable?: (
        ctx: Ctx,
        options: {
          input: [INPUT] extends [never] ? unknown : INPUT;
        } & AgentToolExecutionOptions<TOOL_CONTEXT>,
      ) => void | PromiseLike<void>;
    } & ToolOutputPropertiesCtx<INPUT, OUTPUT, Ctx, TOOL_CONTEXT> & {
      /**
       * Optional conversion function that maps the tool result to an output that can be used by the language model.
       *
       * If not provided, the tool result will be sent as a JSON object.
       */
      toModelOutput?: (
        ctx: Ctx,
        options: {
          /**
           * The ID of the tool call. You can use it e.g. when sending tool-call related information with stream data.
           */
          toolCallId: string;
          /**
           * The input of the tool call.
           */
          input: [INPUT] extends [never] ? unknown : INPUT;
          /**
           * The output of the tool call.
           */
          output: 0 extends 1 & OUTPUT
            ? any
            : [OUTPUT] extends [never]
              ? any
              : NoInfer<OUTPUT>;
        },
      ) => ToolResultOutput | PromiseLike<ToolResultOutput>;
    },
): Tool<INPUT, OUTPUT, TOOL_CONTEXT> {
  // Runtime backwards compat - types will show errors but runtime still works
  const inputSchema = def.inputSchema ?? (def as any).args;
  if (!inputSchema)
    throw new Error("To use a Convex tool, you must provide an `inputSchema`");

  if ((def as any).args && !def.inputSchema) {
    warnDeprecation(
      "createTool.args",
      "createTool: 'args' is deprecated. Use 'inputSchema' instead.",
    );
  }
  if ((def as any).handler && !def.execute) {
    warnDeprecation(
      "createTool.handler",
      "createTool: 'handler' is deprecated. Use 'execute' instead.",
    );
  }

  const { mutation, query, resume } = def;
  const executeHandler:
    | ToolExecuteFunctionCtx<INPUT, OUTPUT, Ctx, TOOL_CONTEXT>
    | undefined = mutation
    ? async (ctx, input, options) => {
        let ran = false;
        return mutation(
          {
            ...readOnly(ctx),
            runMutation: (reference, ...args) => {
              if (ran) throw new Error(ONE_MUTATION);
              ran = true;
              return ctx.runMutation(reference, ...args);
            },
          } as MutationToolCtx<Ctx>,
          input,
          options,
        );
      }
    : query
      ? async (ctx, input, options) => query(readOnly(ctx), input, options)
      : (def.execute ?? (def as any).handler);
  if (!executeHandler && def.needsApproval) {
    throw new Error(
      "A client tool (one without execute) cannot need approval." +
        " Ask the user in the client before calling addToolOutput.",
    );
  }

  const t = tool<INPUT, OUTPUT, TOOL_CONTEXT>({
    type: "function",
    __acceptsCtx: true,
    ctx: def.ctx,
    description: def.description,
    title: def.title,
    providerOptions: def.providerOptions,
    metadata: def.metadata,
    inputSchema,
    contextSchema: def.contextSchema,
    inputExamples: def.inputExamples,
    needsApproval(this: Tool<INPUT, OUTPUT, TOOL_CONTEXT>, input, options) {
      const needsApproval = def.needsApproval;
      if (!needsApproval || typeof needsApproval === "boolean")
        return Boolean(needsApproval);

      if (!getCtx(this)) {
        throw new Error(
          "To use a Convex tool, you must either provide the ctx" +
            " at definition time (dynamically in an action), or use the Agent to" +
            " call it (which injects the ctx, userId and threadId)",
        );
      }
      return needsApproval(getCtx(this), input, options);
    },
    strict: def.strict,
    ...(executeHandler
      ? {
          execute(
            this: Tool<INPUT, OUTPUT, TOOL_CONTEXT>,
            input: INPUT,
            options: ToolExecutionOptions<TOOL_CONTEXT>,
          ) {
            if (!getCtx(this)) {
              throw new Error(
                "To use a Convex tool, you must either provide the ctx" +
                  " at definition time (dynamically in an action), or use the Agent to" +
                  " call it (which injects the ctx, userId and threadId)",
              );
            }
            return executeHandler(getCtx(this), input, options);
          },
        }
      : {}),
    outputSchema: def.outputSchema,
  });
  if (def.onInputStart) {
    const origOnInputStart = def.onInputStart;
    t.onInputStart = function (
      this: Tool<INPUT, OUTPUT, TOOL_CONTEXT>,
      options,
    ) {
      return origOnInputStart.call(this, getCtx(this), options);
    };
  }
  if (def.onInputDelta) {
    const origOnInputDelta = def.onInputDelta;
    t.onInputDelta = function (
      this: Tool<INPUT, OUTPUT, TOOL_CONTEXT>,
      options,
    ) {
      return origOnInputDelta.call(this, getCtx(this), options);
    };
  }
  if (def.onInputAvailable) {
    const origOnInputAvailable = def.onInputAvailable;
    t.onInputAvailable = function (
      this: Tool<INPUT, OUTPUT, TOOL_CONTEXT>,
      options,
    ) {
      return origOnInputAvailable.call(this, getCtx(this), options);
    };
  }
  const durable: DurableTool | undefined = mutation
    ? { kind: "mutation" }
    : query
      ? { kind: "query" }
      : resume
        ? { kind: "execute", resume: resume as never }
        : undefined;
  if (durable) (t as { [DURABLE]?: DurableTool })[DURABLE] = durable;
  if (def.toModelOutput) {
    const origToModelOutput = def.toModelOutput;
    t.toModelOutput = function (
      this: Tool<INPUT, OUTPUT, TOOL_CONTEXT>,
      options,
    ) {
      return origToModelOutput.call(this, getCtx(this), options);
    };
  }
  return t;
}

function readOnly<Ctx extends ToolCtx>(ctx: Ctx): QueryToolCtx<Ctx> {
  const refuse = () => {
    throw new Error(READ_ONLY);
  };
  return {
    ...ctx,
    runMutation: refuse,
    runAction: refuse,
    scheduler: undefined,
  };
}

function getCtx<Ctx extends ToolCtx>(tool: any): Ctx {
  return (tool as { ctx: Ctx }).ctx;
}

export function wrapTools(
  ctx: ToolCtx,
  ...toolSets: (ToolSet | undefined)[]
): ToolSet {
  const output = {} as ToolSet;
  for (const toolSet of toolSets) {
    if (!toolSet) {
      continue;
    }
    for (const [name, tool] of Object.entries(toolSet)) {
      if (tool && !(tool as any).__acceptsCtx) {
        output[name] = tool;
      } else {
        const out = { ...tool, ctx };
        output[name] = out;
      }
    }
  }
  return output;
}
