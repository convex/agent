import type {
  LanguageModelV4,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type {
  LanguageModel,
  LanguageModelCallEndEvent,
  LanguageModelUsage,
  ProviderMetadata,
  ToolExecutionEndEvent,
  ToolSet,
} from "ai";
import { getErrorMessage } from "@ai-sdk/provider-utils";
import { gateway } from "ai";
import {
  createFunctionHandle,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { decodeToolResult, encodeToolResult } from "../../shared.js";
import { durableTool, type ToolCtx } from "./createTool.js";
import type { ActionCtx, AgentComponent } from "./types.js";

/** A step a dead job recorded, with its calls' results, as a retry replays it. */
export type ToolReplay = NonNullable<
  FunctionReturnType<AgentComponent["tools"]["replay"]>
>;

/** What the model sees for a call whose result its crashed job didn't record. */
export const INTERRUPTED =
  "The tool call was interrupted before its result was saved, so its outcome is unknown.";

/** Why a mutation or execute call in an unrecorded step didn't run. */
export const UNRECORDED =
  "The tool call didn't run: its step couldn't be recorded, so it couldn't run exactly once.";

/** A model call's step, as the model returned it. */
type RecordedStep = {
  provider: string;
  modelId: string;
  responseId: string;
  content: LanguageModelV4Content[];
  finishReason: LanguageModelV4FinishReason["unified"];
  usage: LanguageModelV4Usage;
  providerMetadata?: ProviderMetadata;
};

type RecordedResult = ReturnType<typeof decodeToolResult>;

const outcome = (result: RecordedResult) => {
  if ("error" in result) throw new Error(result.error);
  return result.output;
};

/**
 * A durable generation's tool steps. A step with an `execute` call is
 * recorded on its pending message when its model call ends, which the AI SDK
 * awaits before it runs any tool (`onLanguageModelCallEnd`), and each result
 * as its tool ends, as a document of its own. A step with a call the AI SDK
 * asks approval for is recorded once both are known, before the step ends.
 * A result is kept under its call's `${ctx.messageId}:${toolCallId}`, the
 * key the docs give tools, so another step's call with its id never gets it.
 * A step of
 * mutation and query calls is recorded by its first mutation, in that
 * mutation's transaction, as each mutation's result is: a crash before one
 * commits left nothing to protect. A step of query calls isn't recorded, so
 * a retry asks the model for it again. A retry takes that message over,
 * record and all, and replays the step through the AI SDK from a model that
 * returns the recorded response, so the step's model call isn't made again: recorded results are returned as they were, and a call
 * without one runs again if that's safe (a mutation tool, which never
 * committed, a query tool, or a tool with `resume`), or is told its outcome is
 * unknown. A continuation's approved calls run before its first model call,
 * on a record of its first pending message. Every write is judged by its caller, so
 * a job its turn moved off records and commits nothing.
 */
export function durableToolSteps(
  ctx: ActionCtx,
  component: AgentComponent,
  {
    durable,
    toolRecord,
    approves,
    pendingMessageId,
    refuse,
    hold,
  }: {
    durable: boolean;
    toolRecord: ToolReplay | undefined;
    /** The generation starts by running its approved calls. */
    approves: boolean;
    pendingMessageId: () => string | undefined;
    /** Ends the generation: its step's tools mustn't run. */
    refuse: (reason: string) => void;
    hold?: <R>(during: Promise<R>) => Promise<R>;
  },
) {
  const replay = toolRecord && {
    model:
      toolRecord.step !== undefined
        ? replayModel(JSON.parse(toolRecord.step) as RecordedStep)
        : undefined,
    results: new Map(
      toolRecord.results.map(({ toolCallId, result }) => [
        toolCallId,
        decodeToolResult(result),
      ]),
    ),
  };
  // Whether the calls the AI SDK runs are the replayed ones: a continuation's
  // approved calls, then the replayed step.
  let replaying = !!replay;
  // The current step's record, settled before its tools run: the message it's
  // on, or why they mustn't run. Unset when the step isn't recorded. Before
  // the first step, the record a continuation's approved calls run on.
  const first = pendingMessageId();
  // A record its first mutation is still to write carries its step.
  let record:
    | { messageId: string; step?: string }
    | { refused: string }
    | undefined =
    durable && first && (toolRecord || approves)
      ? { messageId: first }
      : undefined;
  // Results recorded where they were made, or already on the record.
  const recorded = new Set(replay?.results.keys());
  // Each running call's key, for its end.
  const keys = new Map<string, string>();
  // Calls the AI SDK asked approval for, and the step whose model call ended,
  // for an approval decided after that.
  const approvals = new Set<string>();
  let ended:
    | { messageId: string; step: string; toolCallIds: string[] }
    | undefined;
  const rawInputs = new Map<string, string>();
  // The step's calls still to end, and whether the first step began: a
  // result is written only while it's exposed, as its step's save comes once
  // the step's last call ends, but always for a continuation's approved
  // calls, which run before the first step.
  let unended = new Set<string>();
  let stepping = false;
  const queued: { toolCallId: string; result: string }[] = [];
  let flushing: Promise<void> | undefined;

  const writeRecord = async (messageId: string, args: { step?: string }) => {
    try {
      const writing = ctx.runMutation(component.tools.recordToolStep, {
        messageId,
        results: [],
        ...args,
      });
      const refused = await (hold ? hold(writing) : writing);
      record = refused ? { refused } : { messageId };
      if (refused) refuse(refused);
    } catch {
      // A record that can't be written (too large, say) leaves the step
      // unrecorded: its mutation and execute calls don't run, and a retry
      // calls the model for it again.
      record = undefined;
    }
  };

  const handles = new Map<unknown, Promise<string>>();
  /** A mutation tool's `ctx.runMutation`, recorded for its call. */
  const recordedMutation =
    (on: { messageId: string; step?: string }, key: string) =>
    async (
      reference: FunctionReference<"mutation", "internal">,
      args?: unknown,
    ) => {
      let handle = handles.get(reference);
      if (!handle)
        handles.set(reference, (handle = createFunctionHandle(reference)));
      const result = await ctx.runMutation(component.tools.runToolMutation, {
        messageId: on.messageId,
        toolCallId: key,
        handle: await handle,
        args: args ?? {},
        ...(on.step !== undefined ? { step: on.step } : {}),
      });
      if ("refused" in result) {
        refuse(result.refused);
        throw new Error(result.refused);
      }
      delete on.step;
      return outcome(decodeToolResult(result.result));
    };
  // Tools whose results aren't recorded here: a mutation tool's is recorded
  // with its mutation, and a query tool runs again.
  const rerun = new Set<string>();
  // Tools the AI SDK runs, tools whose calls need their step recorded before
  // they run, and tools whose first mutation records it.
  const runs = new Set<string>();
  const executes = new Set<string>();
  const mutates = new Set<string>();

  /** Records the step a call the AI SDK asks approval for is in. */
  const approving = async (toolCallId: string) => {
    approvals.add(toolCallId);
    unended.delete(toolCallId);
    if (!ended?.toolCallIds.includes(toolCallId)) return;
    const { messageId, step } = ended;
    ended = undefined;
    if (!record || ("step" in record && record.step !== undefined)) {
      await writeRecord(messageId, { step });
    }
  };
  const needsUserApproval = (status: unknown) =>
    status === "user-approval" ||
    (typeof status === "object" &&
      (status as { type?: unknown } | null)?.type === "user-approval");

  const wrapTools = <T extends ToolSet | undefined>(tools: T): T => {
    if (!tools || !durable) return tools;
    return Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => {
        const execute = tool.execute;
        if (!execute) return [name, tool];
        runs.add(name);
        const durably = durableTool(tool);
        const kind = durably?.kind ?? "execute";
        const resume = durably?.kind === "execute" ? durably.resume : undefined;
        if (kind !== "execute") rerun.add(name);
        if (kind === "mutation") mutates.add(name);
        if (kind === "execute") executes.add(name);
        const { needsApproval } = tool;
        return [
          name,
          {
            ...tool,
            ...(needsApproval
              ? {
                  async needsApproval(
                    this: unknown,
                    input: unknown,
                    options: { toolCallId: string },
                  ) {
                    const needs =
                      typeof needsApproval === "function"
                        ? await needsApproval.call(
                            this,
                            input as never,
                            options as never,
                          )
                        : needsApproval;
                    if (needs) await approving(options.toolCallId);
                    return needs;
                  },
                }
              : {}),
            execute(
              this: { ctx: ToolCtx },
              input: unknown,
              options: { toolCallId: string },
            ) {
              const key = `${this.ctx.messageId}:${options.toolCallId}`;
              keys.set(options.toolCallId, key);
              const result =
                replaying && kind === "execute" && replay!.results.get(key);
              if (result) return outcome(result);
              if (record && "refused" in record) {
                throw new Error(record.refused);
              }
              if (kind === "query") {
                return execute.call(this, input, options as never);
              }
              if (!record) throw new Error(UNRECORDED);
              if (kind === "mutation") {
                const runMutation = recordedMutation(record, key);
                return execute.call(
                  { ...this, ctx: { ...this.ctx, runMutation } },
                  input,
                  options as never,
                );
              }
              if (replaying) {
                if (!resume) throw new Error(INTERRUPTED);
                return resume(this.ctx, input, options as never);
              }
              return execute.call(this, input, options as never);
            },
          },
        ];
      }),
    ) as T;
  };

  return {
    wrapTools,
    /** The call's `toolApproval`, telling the record which calls it asks. */
    toolApproval: <A>(toolApproval: A): A => {
      if (!durable || !toolApproval) return toolApproval;
      const observed =
        (
          decide: (...args: never[]) => unknown,
          idOf: (args: never[]) => string,
        ) =>
        async (...args: never[]) => {
          const status = await decide(...args);
          if (needsUserApproval(status)) await approving(idOf(args));
          return status;
        };
      if (typeof toolApproval === "function") {
        return observed(
          toolApproval as never,
          ([options]) =>
            (options as { toolCall: { toolCallId: string } }).toolCall
              .toolCallId,
        ) as A;
      }
      return Object.fromEntries(
        Object.entries(toolApproval).map(([name, status]) => [
          name,
          typeof status === "function" || needsUserApproval(status)
            ? observed(
                typeof status === "function" ? (status as never) : () => status,
                ([, options]) => (options as { toolCallId: string }).toolCallId,
              )
            : status,
        ]),
      ) as A;
    },
    /**
     * The model for a step: a replayed step's recorded response, or the step's
     * own, read for the raw input of its tool calls.
     */
    stepModel: <M>(stepNumber: number, model: M): M | LanguageModel => {
      stepping = true;
      replaying &&= stepNumber === 0 && !!replay?.model;
      record = undefined;
      ended = undefined;
      unended = new Set();
      if (replaying) return replay!.model!;
      if (!durable) return model;
      return readingRawInputs(
        typeof model === "string" ? modelById(model) : model,
        rawInputs,
      );
    },
    onLanguageModelCallEnd: async (
      event: LanguageModelCallEndEvent<ToolSet>,
    ) => {
      const messageId = pendingMessageId();
      if (!durable || !messageId) return;
      // Without our prepareStep, the model called wasn't the replay's.
      if (!stepping) replaying = false;
      const calls = event.content.flatMap((p) =>
        p.type === "tool-call" && !p.providerExecuted ? [p] : [],
      );
      unended = new Set(
        calls.flatMap((call) =>
          runs.has(call.toolName) && !call.invalid ? [call.toolCallId] : [],
        ),
      );
      // A replayed step's record is already on its message.
      if (replaying) {
        record = { messageId };
        return;
      }
      const step = calls.length > 0 && stepRecord(event, rawInputs);
      rawInputs.clear();
      if (!step) return;
      const json = JSON.stringify(step);
      const toolCallIds = calls.map((call) => call.toolCallId);
      if (
        calls.some((call) => executes.has(call.toolName)) ||
        toolCallIds.some((id) => approvals.has(id))
      ) {
        await writeRecord(messageId, { step: json });
      } else {
        ended = { messageId, step: json, toolCallIds };
        if (calls.some((call) => mutates.has(call.toolName))) {
          record = { messageId, step: json };
        }
      }
    },
    onToolExecutionEnd: async (event: ToolExecutionEndEvent<ToolSet>) => {
      const { toolOutput } = event;
      const key = keys.get(toolOutput.toolCallId);
      keys.delete(toolOutput.toolCallId);
      const last = unended.delete(toolOutput.toolCallId) && unended.size === 0;
      if (!record || "refused" in record) return;
      const { messageId } = record;
      if (stepping && last) return;
      if (!key || recorded.has(key)) return;
      if (rerun.has(toolOutput.toolName)) return;
      let result: string;
      try {
        result = encodeToolResult(
          toolOutput.type === "tool-result"
            ? { output: toolOutput.output }
            : { error: getErrorMessage(toolOutput.error) },
        );
      } catch {
        // Unrecorded, so a replay treats it as interrupted.
        return;
      }
      recorded.add(key);
      queued.push({ toolCallId: key, result });
      // One write at a time; results that end meanwhile share the next one.
      flushing ??= (async () => {
        while (queued.length) {
          const results = queued.splice(0);
          await ctx
            .runMutation(component.tools.recordToolStep, {
              messageId,
              results,
            })
            .catch(() => {});
        }
        flushing = undefined;
      })();
      await flushing;
    },
  };
}

/**
 * A model named by id, as the AI SDK resolves one: from its global default
 * provider, else the gateway. The SDK adapts an older provider's model when
 * it calls it.
 */
function modelById(id: string) {
  return (globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway).languageModel(id);
}

/**
 * The step's model, keeping the raw input of each tool call it returns: the
 * AI SDK reports the input parsed, which a replay would parse again.
 */
function readingRawInputs<M>(model: M, rawInputs: Map<string, string>): M {
  if (typeof model !== "object" || model === null || !("doStream" in model)) {
    return model;
  }
  const inner = model as unknown as LanguageModelV4;
  const keep = (part: LanguageModelV4Content | LanguageModelV4StreamPart) => {
    if (part.type === "tool-call") rawInputs.set(part.toolCallId, part.input);
  };
  return Object.assign(Object.create(inner), {
    doGenerate: async (
      options: Parameters<LanguageModelV4["doGenerate"]>[0],
    ) => {
      const result = await inner.doGenerate(options);
      result.content.forEach(keep);
      return result;
    },
    doStream: async (options: Parameters<LanguageModelV4["doStream"]>[0]) => {
      const result = await inner.doStream(options);
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<
            LanguageModelV4StreamPart,
            LanguageModelV4StreamPart
          >({
            transform(part, controller) {
              keep(part);
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  }) as M;
}

function stepRecord(
  event: LanguageModelCallEndEvent<ToolSet>,
  rawInputs: Map<string, string>,
): RecordedStep | undefined {
  const content: LanguageModelV4Content[] = [];
  for (const part of event.content) {
    const providerMetadata =
      "providerMetadata" in part && part.providerMetadata
        ? { providerMetadata: part.providerMetadata }
        : {};
    switch (part.type) {
      case "text":
      case "reasoning":
        content.push({ type: part.type, text: part.text, ...providerMetadata });
        break;
      case "file":
      case "reasoning-file":
        content.push({
          type: part.type,
          mediaType: part.file.mediaType,
          data: { type: "data", data: part.file.base64 },
          ...providerMetadata,
        });
        break;
      case "source":
      case "custom":
        content.push(part);
        break;
      case "tool-approval-request":
        content.push({
          type: "tool-approval-request",
          approvalId: part.approvalId,
          toolCallId: part.toolCall.toolCallId,
          ...providerMetadata,
        });
        break;
      case "tool-call":
        content.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input:
            rawInputs.get(part.toolCallId) ??
            (part.invalid && typeof part.input === "string"
              ? part.input
              : JSON.stringify(part.input)),
          ...(part.providerExecuted ? { providerExecuted: true } : {}),
          ...(part.dynamic ? { dynamic: true } : {}),
          ...providerMetadata,
        });
        break;
      case "tool-result":
      case "tool-error":
        content.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: (part.type === "tool-result"
            ? part.output
            : part.error) as NonNullable<unknown> as never,
          ...(part.type === "tool-error" ? { isError: true } : {}),
          ...(part.dynamic ? { dynamic: true } : {}),
          ...providerMetadata,
        });
        break;
      default:
        // Not replayable as the model returned it, so the step isn't
        // recorded: a retry calls the model for it again.
        return undefined;
    }
  }
  return {
    provider: event.provider,
    modelId: event.modelId,
    responseId: event.responseId,
    content,
    finishReason: event.finishReason,
    usage: modelUsage(event.usage),
    ...(event.providerMetadata
      ? { providerMetadata: event.providerMetadata }
      : {}),
  };
}

// The inverse of the AI SDK's asLanguageModelUsage.
function modelUsage(usage: LanguageModelUsage): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: usage.inputTokens,
      noCache: usage.inputTokenDetails?.noCacheTokens,
      cacheRead: usage.inputTokenDetails?.cacheReadTokens,
      cacheWrite: usage.inputTokenDetails?.cacheWriteTokens,
    },
    outputTokens: {
      total: usage.outputTokens,
      text: usage.outputTokenDetails?.textTokens,
      reasoning: usage.outputTokenDetails?.reasoningTokens,
    },
    ...(usage.raw ? { raw: usage.raw } : {}),
  };
}

/** A model whose one response is a recorded step's, without a provider call. */
function replayModel(step: RecordedStep): LanguageModelV4 {
  const finish = {
    finishReason: { unified: step.finishReason, raw: undefined },
    usage: step.usage,
    ...(step.providerMetadata
      ? { providerMetadata: step.providerMetadata }
      : {}),
  };
  const response = { id: step.responseId, modelId: step.modelId };
  return {
    specificationVersion: "v4",
    provider: step.provider,
    modelId: step.modelId,
    supportedUrls: {},
    doGenerate: async () => ({
      content: step.content,
      ...finish,
      response,
      warnings: [],
    }),
    doStream: async () => {
      const parts: LanguageModelV4StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", ...response },
      ];
      step.content.forEach((part, i) => {
        if (part.type !== "text" && part.type !== "reasoning") {
          parts.push(part);
          return;
        }
        const id = `${i}`;
        const { providerMetadata } = part;
        parts.push(
          { type: `${part.type}-start`, id },
          { type: `${part.type}-delta`, id, delta: part.text },
          {
            type: `${part.type}-end`,
            id,
            ...(providerMetadata ? { providerMetadata } : {}),
          } as LanguageModelV4StreamPart,
        );
      });
      parts.push({ type: "finish", ...finish });
      return {
        stream: new ReadableStream({
          start(controller) {
            parts.forEach((part) => controller.enqueue(part));
            controller.close();
          },
        }),
      };
    },
  };
}
