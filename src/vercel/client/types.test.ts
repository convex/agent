import type { LanguageModelV3, LanguageModelV4 } from "@ai-sdk/provider";
import type { FunctionReference } from "convex/server";
import { expectTypeOf, test } from "vitest";
import type { MessageDoc, OnSaveMessagesArgs } from "../../validators.js";
import type { startGeneration } from "./start.js";
import type { AgentPrompt, Config } from "./types.js";

expectTypeOf<{ languageModel: string }>().toExtend<Config>();
expectTypeOf<{ languageModel: LanguageModelV4 }>().toExtend<Config>();
expectTypeOf<{ languageModel: LanguageModelV3 }>().not.toExtend<Config>();

expectTypeOf<{ model: string }>().toExtend<AgentPrompt>();
expectTypeOf<{ model: LanguageModelV4 }>().toExtend<AgentPrompt>();
expectTypeOf<{ model: LanguageModelV3 }>().not.toExtend<AgentPrompt>();

type OnSave = Config["onSaveMessages"];
type Callback<Args extends Record<string, unknown>> = FunctionReference<
  "mutation",
  "internal",
  Args
>;
expectTypeOf<Callback<OnSaveMessagesArgs>>().toExtend<OnSave>();
expectTypeOf<
  Callback<{
    threadId: string | number;
    userId?: string;
    messages: MessageDoc[];
    label?: string;
  }>
>().toExtend<OnSave>();
expectTypeOf<
  Callback<OnSaveMessagesArgs & { reason: string }>
>().not.toExtend<OnSave>();
expectTypeOf<
  Callback<{ threadId: string; messages: MessageDoc[] }>
>().not.toExtend<OnSave>();
expectTypeOf<
  Callback<{ threadId: number; userId?: string; messages: MessageDoc[] }>
>().not.toExtend<OnSave>();

type Started<T> = Awaited<ReturnType<typeof startGeneration<T>>>["args"];
type Variants = { mode: "a"; a: number } | { mode: "b"; b: string };
expectTypeOf<
  Extract<Started<Variants>, { mode: "a" }>["a"]
>().toEqualTypeOf<number>();
expectTypeOf<
  Extract<Started<Variants>, { mode: "b" }>["b"]
>().toEqualTypeOf<string>();

test("noop", () => {});
