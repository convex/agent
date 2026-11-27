import {
  experimental_decide,
  type Experimental_DecisionAnswer,
  type Experimental_DecisionModel,
  type Experimental_DecisionQuestion,
  type Experimental_DecisionResult,
  type Experimental_DecisionState,
  type Experimental_DecisionStatePart,
  type LanguageModelUsage,
  type ModelMessage,
  type ProviderMetadata,
} from "ai";
import type { JSONValue } from "@ai-sdk/provider";
import type {
  FunctionReturnType,
  PaginationOptions,
  PaginationResult,
} from "convex/server";
import type { Infer } from "convex/values";
import { assert } from "convex-helpers";
import { fetchContextWithPrompt } from "./search.js";
import { serializeUsage } from "../mapping.js";
import {
  answersQuestion,
  decodeAnswer,
  decodeQuestions,
  encodeAnswer,
  MAX_DOCUMENT_BYTES,
  sizeOf,
  tooLarge,
} from "../../decisions.js";
import type {
  ActionCtx,
  AgentComponent,
  AgentPrompt,
  Config,
  MutationCtx,
  Options,
  QueryCtx,
} from "./types.js";
import type { vDecisionAnswer, vDecisionDoc } from "../../validators.js";

export type DecisionQuestions = Record<string, Experimental_DecisionQuestion>;

type DecisionAnswers<QUESTIONS extends DecisionQuestions> =
  Experimental_DecisionResult<QUESTIONS>["answers"];
type AnyAnswer = Infer<typeof vDecisionAnswer>;
type DecisionDocFields = Infer<typeof vDecisionDoc>;
type StoredDecision = NonNullable<
  FunctionReturnType<AgentComponent["decisions"]["findCached"]>
>;

export type DecideArgs<QUESTIONS extends DecisionQuestions> = Omit<
  Parameters<typeof experimental_decide>[0],
  "model" | "state" | "questions" | "_internal"
> &
  Pick<AgentPrompt, "prompt" | "messages" | "promptMessageId"> & {
    questions: QUESTIONS;
    /** Decided after the thread context, and stored with the decision. */
    state?: Experimental_DecisionState;
    /** Replaces the agent's `experimental_decisionModel`. */
    model?: Experimental_DecisionModel;
    /**
     * Return the thread's newest decision made within `ttlMs` with the same
     * provider, requested model, settings and state, if it answered every
     * asked question at the same definition and none of those answers was
     * corrected. A hit calls no decision model, so it stores and reports
     * nothing.
     */
    cache?: { ttlMs: number };
  };

export type DecideResult<QUESTIONS extends DecisionQuestions> =
  Experimental_DecisionResult<QUESTIONS> & {
    /** The stored decision, when there was a thread to store it in. */
    decisionId: string | undefined;
    /** Whether this is the earlier decision `decisionId`, returned by the cache. */
    cached: boolean;
  };

export type DecisionDoc<
  QUESTIONS extends DecisionQuestions = DecisionQuestions,
> = Omit<DecisionDocFields, "answers" | "corrections" | "providerMetadata"> & {
  providerMetadata?: ProviderMetadata;
  /**
   * Answers to the listed questions whose answer type still matches theirs.
   * A question asked only by later decisions is missing.
   */
  answers: {
    -readonly [ID in keyof QUESTIONS]?: Experimental_DecisionAnswer<
      QUESTIONS[ID]
    >;
  };
  corrections: {
    -readonly [ID in keyof QUESTIONS]?: {
      answer: Experimental_DecisionAnswer<QUESTIONS[ID]>;
      by?: string;
    };
  };
};

// Kept free in a decision's document for what the model returns with its
// answers: the model ID, usage and provider metadata.
const MODEL_OUTPUT_RESERVE_BYTES = 64 << 10;

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  // WebCrypto refuses views over a SharedArrayBuffer, so this hashes a copy.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function hash(value: unknown): Promise<string> {
  return sha256(new TextEncoder().encode(stableStringify(value)));
}

// Rewording a question keeps its answer's type; changing a choice's option
// keys or a score's number of levels changes it.
function answerShape(question: Experimental_DecisionQuestion) {
  if (question.type === "choice") {
    return {
      type: question.type,
      options: Object.keys(question.criteria).sort(),
    };
  }
  if (question.type === "score") {
    return { type: question.type, levels: question.criteria.length };
  }
  return { type: question.type };
}

type StateFilePart = Extract<Experimental_DecisionStatePart, { type: "file" }>;

// Files in the context follow the JSON part as file parts, so multimodal
// decision models see them; the JSON keeps their index.
function contextToState(
  messages: ModelMessage[],
): Experimental_DecisionStatePart[] {
  if (!messages.length) return [];
  const files: StateFilePart[] = [];
  const json = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "file" && part.type !== "image") return part;
        const file: StateFilePart =
          part.type === "image"
            ? {
                type: "file",
                data: part.image,
                mediaType: part.mediaType ?? "image",
              }
            : { type: "file", data: part.data, mediaType: part.mediaType };
        files.push(file);
        return {
          type: "file",
          mediaType: file.mediaType,
          stateFile: files.length - 1,
        };
      }),
    };
  });
  // JSON.parse of JSON.stringify output is JSON by construction.
  const value: JSONValue = JSON.parse(JSON.stringify({ messages: json }));
  return [{ type: "json", value }, ...files];
}

// Array.isArray doesn't narrow a readonly array.
function isPartList(
  state: Experimental_DecisionState,
): state is readonly Experimental_DecisionStatePart[] {
  return Array.isArray(state);
}

function toStateParts(
  state: Experimental_DecisionState | undefined,
): Experimental_DecisionStatePart[] {
  if (state === undefined) return [];
  if (typeof state === "string") return [{ type: "text", text: state }];
  if (isPartList(state)) return [...state];
  return [{ type: "json", value: state }];
}

function bytesOf(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && typeof data === "object" && "type" in data && "data" in data) {
    return data.type === "data" ? bytesOf(data.data) : undefined;
  }
  return undefined;
}

// File bytes are replaced by their SHA-256, to hash and store the state.
function digest(parts: readonly Experimental_DecisionStatePart[]) {
  return Promise.all(
    parts.map(async (part) => {
      const bytes = part.type === "file" ? bytesOf(part.data) : undefined;
      return bytes ? { ...part, data: { sha256: await sha256(bytes) } } : part;
    }),
  );
}

// Decision models often report input tokens alone, where the AI SDK leaves the
// total undefined, which usage handlers and rate limits would count as zero.
function toUsage(
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
): LanguageModelUsage {
  const { inputTokens, outputTokens } = usage ?? {};
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens === undefined && outputTokens === undefined
        ? undefined
        : (inputTokens ?? 0) + (outputTokens ?? 0),
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  };
}

function isAnswerTo<QUESTION extends Experimental_DecisionQuestion>(
  question: QUESTION,
  answer: AnyAnswer,
): answer is AnyAnswer & Experimental_DecisionAnswer<QUESTION> {
  return answersQuestion(question, answer);
}

function decodeDecision<QUESTIONS extends DecisionQuestions>(
  {
    answers: rows,
    questions: storedQuestions,
    settings,
    ...doc
  }: StoredDecision,
  asked?: QUESTIONS,
): DecisionDoc<QUESTIONS> {
  const questions = decodeQuestions(storedQuestions);
  const askedQuestions: DecisionQuestions = asked ?? questions;
  const answers: [string, AnyAnswer][] = [];
  const corrections: [string, { answer: AnyAnswer; by?: string }][] = [];
  for (const { questionId, answer, correction } of rows) {
    if (!Object.hasOwn(askedQuestions, questionId)) continue;
    const question = askedQuestions[questionId];
    const decoded = decodeAnswer(answer);
    if (isAnswerTo(question, decoded)) answers.push([questionId, decoded]);
    const corrected = correction && decodeAnswer(correction.answer);
    if (corrected && isAnswerTo(question, corrected)) {
      corrections.push([questionId, { answer: corrected, by: correction.by }]);
    }
  }
  return {
    ...doc,
    questions,
    settings: settings === undefined ? undefined : JSON.parse(settings),
    answers: Object.fromEntries(answers) as DecisionDoc<QUESTIONS>["answers"],
    corrections: Object.fromEntries(
      corrections,
    ) as DecisionDoc<QUESTIONS>["corrections"],
  };
}

function answersAll<QUESTIONS extends DecisionQuestions>(
  questions: QUESTIONS,
  answers: DecisionDoc<QUESTIONS>["answers"],
): answers is DecisionAnswers<QUESTIONS> {
  return Object.keys(questions).every((id) => Object.hasOwn(answers, id));
}

export async function decide<const QUESTIONS extends DecisionQuestions>(
  ctx: ActionCtx,
  component: AgentComponent,
  args: DecideArgs<QUESTIONS>,
  opts: Options &
    Config & {
      userId?: string | null;
      threadId?: string;
      agentName?: string;
    },
): Promise<DecideResult<QUESTIONS>> {
  const {
    questions,
    state: callerState,
    prompt,
    messages,
    promptMessageId,
    model: modelArg,
    cache,
    ...settings
  } = args;
  const model = modelArg ?? opts.experimental_decisionModel;
  assert(model, "experimental_decide needs an experimental_decisionModel");
  const requestedModel = typeof model === "string" ? model : model.modelId;
  const provider =
    typeof model === "string" ? model.split("/")[0] : model.provider;
  const { threadId } = opts;
  const thread = threadId
    ? await ctx.runQuery(component.threads.getThread, { threadId })
    : undefined;
  if (threadId) assert(thread, `Thread ${threadId} not found`);
  const userId = opts.userId ?? thread?.userId;
  const context =
    threadId || prompt || messages || promptMessageId
      ? await fetchContextWithPrompt(ctx, component, {
          ...opts,
          userId,
          threadId,
          prompt,
          messages,
          promptMessageId,
        })
      : { messages: [], messageIds: [], order: undefined };
  const state = [
    ...contextToState(context.messages),
    ...toStateParts(callerState),
  ];
  const stateHash = await hash(await digest(state));
  const asked = await Promise.all(
    Object.entries(questions).map(async ([questionId, question]) => ({
      questionId,
      definitionHash: await hash(question),
      shapeHash: await hash(answerShape(question)),
    })),
  );

  // The options that change the answer, so the cache keys on them too.
  const { maxOutputTokens, reasoning, providerOptions } = settings;
  const callSettings =
    maxOutputTokens === undefined &&
    reasoning === undefined &&
    providerOptions === undefined
      ? undefined
      : { maxOutputTokens, reasoning, providerOptions };
  const cacheKey = await hash({
    stateHash,
    requestedModel,
    provider,
    settings: callSettings,
  });
  const row =
    threadId && opts.storageOptions?.saveMessages !== "none"
      ? {
          threadId,
          agentName: opts.agentName,
          promptMessageId,
          order: context.order,
          contextMessageIds: context.messageIds,
          state:
            callerState === undefined
              ? undefined
              : JSON.stringify(
                  isPartList(callerState)
                    ? await digest(callerState)
                    : callerState,
                ),
          stateHash,
          cacheKey,
          questions: JSON.stringify(questions),
          requestedModel,
          provider,
          settings: callSettings && JSON.stringify(callSettings),
        }
      : undefined;
  const limit = MAX_DOCUMENT_BYTES - MODEL_OUTPUT_RESERVE_BYTES;
  const before = row && sizeOf(row);
  if (before && before.size > limit) {
    throw new Error(
      `The decision's state, questions, context message IDs and settings are ${before.size} bytes, over the ${limit} bytes Convex's 1 MiB document limit leaves for them; the largest is ${before.largest}. Pass a smaller state, fewer context messages, or shorter questions.`,
    );
  }
  const store = async (
    {
      answers,
      ...decision
    }: {
      model: string;
      answers: Readonly<Record<string, AnyAnswer>>;
      usage?: DecisionDoc["usage"];
      providerMetadata?: ProviderMetadata;
    },
    result?: Experimental_DecisionResult<QUESTIONS>,
  ) => {
    if (!row) return undefined;
    const answerRows = asked.map((a) => ({
      ...a,
      answer: encodeAnswer(answers[a.questionId]),
    }));
    const error = [
      tooLarge("The decision with what the model returned", {
        ...row,
        ...decision,
      }),
      ...answerRows.map((answerRow) =>
        tooLarge(`The answer to ${answerRow.questionId}`, {
          ...answerRow,
          threadId: row.threadId,
        }),
      ),
    ].find((e) => e !== undefined);
    if (error) {
      throw new Error(`${error} The model's result is this error's cause.`, {
        cause: result,
      });
    }
    return ctx.runMutation(component.decisions.create, {
      ...row,
      ...decision,
      answers: answerRows,
    });
  };

  if (cache && threadId) {
    const cached = await ctx.runQuery(component.decisions.findCached, {
      threadId,
      cacheKey,
      notBefore: Date.now() - cache.ttlMs,
      asked: asked.map(({ questionId, definitionHash }) => ({
        questionId,
        definitionHash,
      })),
    });
    const answers = cached && decodeDecision(cached, questions).answers;
    if (cached && answers && answersAll(questions, answers)) {
      return {
        answers,
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
        warnings: [],
        rounding: undefined,
        providerMetadata: undefined,
        response: {
          modelId: cached.model,
          timestamp: new Date(cached._creationTime),
        },
        decisionId: cached._id,
        cached: true,
      };
    }
  }

  const result = await experimental_decide({
    ...settings,
    model,
    state,
    questions,
  });
  const usage = toUsage(result.usage);
  await opts.usageHandler?.(ctx, {
    userId,
    threadId,
    agentName: opts.agentName,
    model: result.response.modelId,
    provider,
    usage,
    providerMetadata: result.providerMetadata,
    promptMessageId,
  });
  const decisionId = await store(
    {
      model: result.response.modelId,
      usage: serializeUsage(usage),
      providerMetadata: result.providerMetadata,
      answers: result.answers,
    },
    result,
  );
  return Object.assign(result, { decisionId, cached: false });
}

/**
 * A thread's stored decisions, newest first. With `questions`, only those that
 * answered one of them with the same answer type, with just those answers,
 * typed by them.
 */
export async function listDecisions<const QUESTIONS extends DecisionQuestions>(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  component: AgentComponent,
  args: {
    threadId: string;
    questions: QUESTIONS;
    paginationOpts: PaginationOptions;
  },
): Promise<PaginationResult<DecisionDoc<QUESTIONS>>>;
export async function listDecisions(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  component: AgentComponent,
  args: {
    threadId: string;
    questions?: undefined;
    paginationOpts: PaginationOptions;
  },
): Promise<PaginationResult<DecisionDoc>>;
export async function listDecisions<const QUESTIONS extends DecisionQuestions>(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  component: AgentComponent,
  args: {
    threadId: string;
    questions?: QUESTIONS;
    paginationOpts: PaginationOptions;
  },
): Promise<
  PaginationResult<DecisionDoc<QUESTIONS>> | PaginationResult<DecisionDoc>
> {
  const { questions } = args;
  const result = await ctx.runQuery(component.decisions.list, {
    threadId: args.threadId,
    paginationOpts: args.paginationOpts,
    asked:
      questions &&
      (await Promise.all(
        Object.entries(questions).map(async ([questionId, question]) => ({
          questionId,
          shapeHash: await hash(answerShape(question)),
        })),
      )),
  });
  return {
    ...result,
    page: result.page.map((doc) => decodeDecision(doc, questions)),
  };
}

/**
 * Records the right answer to one question of a stored decision, next to the
 * model's. A later correction of the same question replaces it.
 */
export async function correctDecision<
  const QUESTIONS extends DecisionQuestions,
  ID extends keyof QUESTIONS & string,
>(
  ctx: MutationCtx | ActionCtx,
  component: AgentComponent,
  args: {
    threadId: string;
    decisionId: string;
    /** Only types `questionId` and `answer`. */
    questions?: QUESTIONS;
    questionId: ID;
    answer: DecisionAnswers<QUESTIONS>[ID];
    by?: string;
  },
): Promise<void> {
  await ctx.runMutation(component.decisions.correct, {
    threadId: args.threadId,
    decisionId: args.decisionId,
    questionId: args.questionId,
    answer: encodeAnswer(args.answer),
    by: args.by,
  });
}
