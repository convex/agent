import type {
  experimental_decide,
  Experimental_DecisionAnswer,
  Experimental_DecisionQuestion,
  FinishReason,
  ProviderMetadata,
} from "ai";
import type { GenericId, Infer } from "convex/values";
import { expectTypeOf, test } from "vitest";
import type {
  ContextOptions,
  StorageOptions,
} from "./vercel/client/types.js";
import type { DecisionDoc } from "./vercel/client/decide.js";
import {
  vContextOptions,
  vDecisionAnswer,
  vDecisionQuestion,
  vDecisionSettings,
  vFinishReason,
  vMessageDoc,
  vStorageOptions,
} from "./validators.js";
import type { Doc } from "./component/_generated/dataModel.js";

expectTypeOf<Infer<typeof vContextOptions>>().toExtend<ContextOptions>();
expectTypeOf<ContextOptions>().toExtend<Infer<typeof vContextOptions>>();

expectTypeOf<Infer<typeof vStorageOptions>>().toExtend<StorageOptions>();
expectTypeOf<StorageOptions>().toExtend<Infer<typeof vStorageOptions>>();

expectTypeOf<FinishReason>().toExtend<Infer<typeof vFinishReason>>();

type MessageBasedOnSchema = IdsToStrings<
  Omit<Doc<"messages">, "files" | "stepId" | "parentMessageId" | "textLengths">
>;
expectTypeOf<Infer<typeof vMessageDoc>>().toEqualTypeOf<MessageBasedOnSchema>();
expectTypeOf<MessageBasedOnSchema>().toEqualTypeOf<Infer<typeof vMessageDoc>>();

expectTypeOf<Infer<typeof vDecisionAnswer>>().toEqualTypeOf<
  Experimental_DecisionAnswer<Experimental_DecisionQuestion>
>();
expectTypeOf<
  Infer<typeof vDecisionQuestion>
>().toExtend<Experimental_DecisionQuestion>();
expectTypeOf<Mutable<Experimental_DecisionQuestion>>().toExtend<
  Infer<typeof vDecisionQuestion>
>();
type DecideSettings = Pick<
  Parameters<typeof experimental_decide>[0],
  "maxOutputTokens" | "reasoning" | "providerOptions"
>;
expectTypeOf<Infer<typeof vDecisionSettings>>().toExtend<DecideSettings>();
expectTypeOf<DecideSettings>().toExtend<Infer<typeof vDecisionSettings>>();
expectTypeOf<DecisionDoc["providerMetadata"]>().toEqualTypeOf<
  ProviderMetadata | undefined
>();

test("noop", () => {});

// Convex validators infer mutable arrays where the AI SDK has readonly ones.
type Mutable<T> = T extends unknown
  ? { -readonly [K in keyof T]: T[K] extends readonly (infer E)[] ? E[] : T[K] }
  : never;

type IdsToStrings<T> =
  T extends GenericId<string>
    ? string
    : T extends (infer U)[]
      ? IdsToStrings<U>[]
      : T extends ArrayBuffer
        ? ArrayBuffer
        : T extends object
          ? { [K in keyof T]: IdsToStrings<T[K]> }
          : T;
