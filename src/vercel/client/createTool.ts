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
import type { GenericActionCtx, GenericDataModel } from "convex/server";
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
    messageId?: string;
  };

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

export type ToolOutputPropertiesCtx<
  INPUT,
  OUTPUT,
  Ctx extends ToolCtx = ToolCtx,
  TOOL_CONTEXT extends Context = Context,
> = NeverOptional<
  OUTPUT,
  {
    /**
     * An async function that is called with the arguments from the tool call and produces a result.
     * If `execute` is not provided, the tool will not be executed automatically.
     *
     * @param input - The input of the tool call.
     * @param options.abortSignal - A signal that can be used to abort the tool call.
     */
    execute?: ToolExecuteFunctionCtx<INPUT, OUTPUT, Ctx, TOOL_CONTEXT>;
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
 * tool call, including the action context, userId, threadId, and messageId.
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

  const executeHandler = def.execute ?? (def as any).handler;

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
