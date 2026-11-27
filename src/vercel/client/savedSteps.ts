import type {
  LanguageModelUsage,
  ModelMessage,
  StepResult,
  StopCondition,
  ToolSet,
} from "ai";
import type { Context } from "@ai-sdk/provider-utils";
import type { MessageDoc, Usage } from "../../validators.js";
import { toModelMessage } from "../mapping.js";

type Part = Record<string, unknown> & { type: string };

function usageOf(usage: Usage | undefined): LanguageModelUsage {
  return {
    inputTokens: usage?.promptTokens,
    outputTokens: usage?.completionTokens,
    totalTokens: usage?.totalTokens,
    inputTokenDetails: {
      noCacheTokens: usage?.nonCachedInputTokens,
      cacheReadTokens: usage?.cachedInputTokens,
      cacheWriteTokens: usage?.cacheWriteInputTokens,
    },
    outputTokenDetails: {
      textTokens: usage?.textOutputTokens,
      reasoningTokens: usage?.reasoningTokens,
    },
    raw: usage?.raw,
  } as LanguageModelUsage;
}

function outputParts(
  message: ModelMessage,
  inputs: Map<string, unknown>,
): Part[] {
  if (!Array.isArray(message.content)) return [];
  return (message.content as Part[]).flatMap((part): Part[] => {
    if (part.type !== "tool-result") return [];
    const output = part.output as { type: string; value?: unknown };
    const base = {
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: inputs.get(part.toolCallId as string),
    };
    if (output.type === "error-text" || output.type === "error-json") {
      return [{ type: "tool-error", ...base, error: output.value }];
    }
    if (output.type === "execution-denied") return [];
    return [{ type: "tool-result", ...base, output: output.value }];
  });
}

/**
 * The steps a generation at a prompt already saved after it, as the AI SDK's
 * steps: a resumed generation counts them toward its stop conditions as if it
 * had never stopped. The AI SDK has no way to start a call with prior steps,
 * so each one is rebuilt from its saved messages.
 */
export function savedSteps<TOOLS extends ToolSet, CONTEXT extends Context>(
  responseDocs: MessageDoc[],
): StepResult<TOOLS, CONTEXT>[] {
  const steps: { doc: MessageDoc; messages: ModelMessage[] }[] = [];
  for (const doc of responseDocs) {
    if (doc.status !== "success" || !doc.message) continue;
    const message = toModelMessage(doc.message);
    if (message.role === "assistant") steps.push({ doc, messages: [message] });
    else if (message.role === "tool") steps.at(-1)?.messages.push(message);
  }
  return steps.map(({ doc, messages }, stepNumber) => {
    const [assistant, ...results] = messages;
    const content = (
      Array.isArray(assistant.content)
        ? (assistant.content as Part[])
        : [{ type: "text", text: assistant.content }]
    ).filter((part) => part.type !== "tool-result");
    const inputs = new Map(
      content
        .filter((part) => part.type === "tool-call")
        .map((part) => [part.toolCallId as string, part.input]),
    );
    const all = [
      ...content,
      ...results.flatMap((message) => outputParts(message, inputs)),
    ];
    const of = (type: string) => all.filter((part) => part.type === type);
    const reasoning = of("reasoning");
    return {
      callId: doc._id,
      stepNumber,
      model: { provider: doc.provider ?? "", modelId: doc.model ?? "" },
      toolsContext: {},
      runtimeContext: {},
      content: all,
      text: of("text")
        .map((part) => part.text)
        .join(""),
      reasoning,
      reasoningText: reasoning.length
        ? reasoning.map((part) => part.text).join("")
        : undefined,
      files: [],
      sources: doc.sources ?? [],
      toolCalls: of("tool-call"),
      staticToolCalls: of("tool-call"),
      dynamicToolCalls: [],
      toolResults: of("tool-result"),
      staticToolResults: of("tool-result"),
      dynamicToolResults: [],
      finishReason: doc.finishReason ?? "stop",
      rawFinishReason: undefined,
      usage: usageOf(doc.usage),
      performance: {},
      warnings: doc.warnings,
      request: {},
      response: {
        id: doc._id,
        timestamp: new Date(doc._creationTime),
        modelId: doc.model ?? "",
        messages,
      },
      providerMetadata: doc.providerMetadata,
    } as unknown as StepResult<TOOLS, CONTEXT>;
  });
}

/** Each condition sees the saved steps ahead of the call's own. */
export function afterSavedSteps<TOOLS extends ToolSet, CONTEXT extends Context>(
  conditions: StopCondition<TOOLS, CONTEXT>[],
  saved: StepResult<TOOLS, CONTEXT>[],
): StopCondition<TOOLS, CONTEXT>[] {
  if (saved.length === 0) return conditions;
  return conditions.map(
    (condition) =>
      ({ steps }) =>
        condition({ steps: [...saved, ...steps] }),
  );
}
