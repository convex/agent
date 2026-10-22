import { type EmbeddingModel } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { groq } from "@ai-sdk/groq";
import { getServiceToken } from "convex/server";
import { convexGateway } from "@convex-dev/ai-sdk-provider";
import { mockModel } from "@convex-dev/agent";

let languageModel: LanguageModelV4;
// Note: This is only defined when OPENAI_API_KEY is set. Consumers should
// handle the undefined case at runtime when using non-OpenAI providers.
let embeddingModel: EmbeddingModel;

if (process.env.ANTHROPIC_API_KEY) {
  languageModel = anthropic.chat("claude-opus-4-20250514");
} else if (process.env.OPENAI_API_KEY) {
  languageModel = openai.chat("gpt-4o-mini");
  embeddingModel = openai.embedding("text-embedding-3-small");
} else if (process.env.GROQ_API_KEY) {
  languageModel = groq.languageModel(
    "meta-llama/llama-4-scout-17b-16e-instruct",
  );
} else {
  // No API key configured: use the Convex AI gateway where it's available, and
  // fall back to a mock model where it isn't.
  languageModel = gatewayWithMockFallback("openai/gpt-5.6-luna");
}

let gatewayAvailable: boolean | undefined;

async function gatewayIsAvailable(): Promise<boolean> {
  if (gatewayAvailable !== undefined) return gatewayAvailable;
  try {
    await getServiceToken("ai-gateway");
    gatewayAvailable = true;
  } catch (error) {
    gatewayAvailable = false;
    console.warn(
      `The AI gateway can't be used from this deployment. ` +
        `Examples will respond with mock text. ` +
        `Run "npx convex env set GROQ_API_KEY=<your-api-key>" or ` +
        `"npx convex env set OPENAI_API_KEY=<your-api-key>" from the ` +
        `example directory to use a real model.` +
        `\n\nSyscall error: ${error}`,
    );
  }
  return gatewayAvailable;
}

function gatewayWithMockFallback(modelId: string): LanguageModelV4 {
  const gateway = convexGateway(modelId);
  const fallback = mockModel({});
  const model = async (): Promise<LanguageModelV4> =>
    (await gatewayIsAvailable()) ? gateway : fallback;
  return {
    specificationVersion: gateway.specificationVersion,
    provider: gateway.provider,
    modelId: gateway.modelId,
    supportedUrls: gateway.supportedUrls,
    doGenerate: async (options) => (await model()).doGenerate(options),
    doStream: async (options) => (await model()).doStream(options),
  };
}

// If you want to use different models for examples, you can change them here.
export { languageModel, embeddingModel };
