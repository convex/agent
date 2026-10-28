import type { LanguageModelV3, LanguageModelV4 } from "@ai-sdk/provider";
import { expectTypeOf, test } from "vitest";
import type { Agent } from "../index.js";
import type { startGeneration } from "./start.js";
import type { AgentPrompt, Config } from "./types.js";

expectTypeOf<{ languageModel: string }>().toExtend<Config>();
expectTypeOf<{ languageModel: LanguageModelV4 }>().toExtend<Config>();
expectTypeOf<{ languageModel: LanguageModelV3 }>().not.toExtend<Config>();

expectTypeOf<{ model: string }>().toExtend<AgentPrompt>();
expectTypeOf<{ model: LanguageModelV4 }>().toExtend<AgentPrompt>();
expectTypeOf<{ model: LanguageModelV3 }>().not.toExtend<AgentPrompt>();

type Started<T> = Awaited<ReturnType<typeof startGeneration<T>>>["args"];
type Variants = { mode: "a"; a: number } | { mode: "b"; b: string };
expectTypeOf<
  Extract<Started<Variants>, { mode: "a" }>["a"]
>().toEqualTypeOf<number>();
expectTypeOf<
  Extract<Started<Variants>, { mode: "b" }>["b"]
>().toEqualTypeOf<string>();

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type ManyModelIds = `provider/model-${Digit}${Digit}${Digit}`;
type StartArgs<T> = Parameters<typeof startGeneration<T>>[2];
declare const _agent: Agent;
type AgentStartArgs<T extends object> = Parameters<
  typeof _agent.start<undefined, T>
>[1];
expectTypeOf<{ model: ManyModelIds }>().toExtend<
  StartArgs<{ model: ManyModelIds }>
>();
expectTypeOf<{ model: ManyModelIds }>().toExtend<
  AgentStartArgs<{ model: ManyModelIds }>
>();
expectTypeOf<{ model: LanguageModelV3 }>().not.toExtend<
  StartArgs<{ model: LanguageModelV3 }>
>();
type ModelOrDefault =
  | { kind: "override"; model: ManyModelIds }
  | { kind: "default" };
expectTypeOf<ModelOrDefault>().toExtend<StartArgs<ModelOrDefault>>();
type V3OrDefault =
  | { kind: "override"; model: LanguageModelV3 }
  | { kind: "default" };
expectTypeOf<V3OrDefault>().not.toExtend<StartArgs<V3OrDefault>>();
expectTypeOf<{ model: LanguageModelV3 }>().not.toExtend<
  AgentStartArgs<{ model: LanguageModelV3 }>
>();

test("noop", () => {});
