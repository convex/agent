import { simulateReadableStream, stepCountIs } from "ai";
import { getFunctionName } from "convex/server";
import { z } from "zod/v4";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { Agent, createTool, TurnError } from "../index.js";
import { components, initConvexTest } from "./setup.test.js";
import { mockModel } from "./mockModel.js";
import type { ActionCtx } from "./types.js";

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

const never = new Promise<never>(() => {});

/** One model response: tool calls by name, or text. */
export type Step = {
  calls?: { tool: string; input?: object; id?: string }[];
  text?: string;
  content?: LanguageModelV4Content[];
};

export const world = {
  plan: [] as Step[],
  runs: {} as Record<string, number>,
  modelCalls: 0,
  prompts: [] as LanguageModelV4CallOptions["prompt"][],
  holds: {} as Record<string, Promise<void> | undefined>,
  needsApproval: false,
  streamError: false,
};

export function reset(plan: Step[]) {
  world.plan = plan;
  world.runs = {};
  world.modelCalls = 0;
  world.prompts = [];
  world.holds = {};
  world.needsApproval = false;
  world.streamError = false;
}

/** Holds `tool` mid-call until the returned function is called. */
export function hold(tool: string) {
  let open!: () => void;
  world.holds[tool] = new Promise<void>((resolve) => (open = resolve));
  return () => {
    world.holds[tool] = undefined;
    open();
  };
}

const run = (name: string) => async () => {
  world.runs[name] = (world.runs[name] ?? 0) + 1;
  await world.holds[name];
};

// The step is the number of model responses since the last user message, so
// a replay or retry asks for the same step.
function respond(
  options: LanguageModelV4CallOptions,
): LanguageModelV4GenerateResult {
  world.modelCalls++;
  world.prompts.push(options.prompt);
  const lastUser = options.prompt.map((m) => m.role).lastIndexOf("user");
  const step = options.prompt
    .slice(lastUser)
    .filter((m) => m.role === "assistant").length;
  const s = world.plan[step] ?? { text: "All done" };
  const content: LanguageModelV4Content[] = s.content ?? [
    ...(s.text ? [{ type: "text" as const, text: s.text }] : []),
    ...(s.calls ?? []).map((c) => ({
      type: "tool-call" as const,
      toolCallId: c.id ?? `${c.tool}-${step}`,
      toolName: c.tool,
      input: JSON.stringify(c.input ?? {}),
    })),
  ];
  return {
    content,
    finishReason: {
      unified: content.some((c) => c.type === "tool-call")
        ? "tool-calls"
        : "stop",
      raw: undefined,
    },
    usage: USAGE,
    warnings: [],
  };
}

function toStream(
  result: LanguageModelV4GenerateResult,
): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    ...result.content.flatMap((part, i): LanguageModelV4StreamPart[] =>
      part.type === "text"
        ? [
            { type: "text-start", id: `t${i}` },
            { type: "text-delta", id: `t${i}`, delta: part.text },
            { type: "text-end", id: `t${i}` },
          ]
        : part.type === "reasoning"
          ? [
              { type: "reasoning-start", id: `r${i}` },
              { type: "reasoning-delta", id: `r${i}`, delta: part.text },
              { type: "reasoning-end", id: `r${i}` },
            ]
          : [part as LanguageModelV4StreamPart],
    ),
    ...(world.streamError
      ? [{ type: "error" as const, error: new Error("provider error") }]
      : []),
    { type: "finish", finishReason: result.finishReason, usage: result.usage },
  ];
}

export const model = (modelId = "mock") =>
  mockModel({
    modelId,
    doGenerate: async (options) => respond(options),
    doStream: async (options) => ({
      stream: simulateReadableStream({ chunks: toStream(respond(options)) }),
    }),
  });

export const tools = {
  note: createTool({
    description: "Returns nothing",
    inputSchema: z.object({}),
    execute: async () => {
      await run("note")();
    },
  }),
  pay: createTool({
    description: "Needs approval when the app says so",
    inputSchema: z.object({}),
    needsApproval: () => world.needsApproval,
    execute: async () => {
      await run("pay")();
      return "paid";
    },
  }),
  confirm: createTool({
    description: "Answered by the client, after approval",
    inputSchema: z.object({ q: z.string() }),
    outputSchema: z.string(),
    needsApproval: true,
  }),
};

export const agent = new Agent(components.agent, {
  name: "durable",
  languageModel: model(),
  tools,
  stopWhen: stepCountIs(6),
});

export function functionName(ref: unknown) {
  const path = (ref as Record<symbol, unknown>)[Symbol.for("toReferencePath")];
  if (typeof path === "string") return path.split("/").slice(-2).join("/");
  return getFunctionName(ref as never);
}

/**
 * A ctx whose action dies once `when` says so for a call it starts: that
 * call and everything after it never reach the database.
 */
export function dying(
  ctx: ActionCtx,
  when: (name: string, args: unknown) => boolean,
) {
  let dead = false;
  const wrap =
    <F extends (ref: never, args: never) => Promise<unknown>>(fn: F) =>
    (ref: never, args: never) => {
      if (!dead && when(functionName(ref), args)) dead = true;
      return dead ? never : fn(ref, args);
    };
  const wrapped = {
    ...ctx,
    runMutation: wrap(ctx.runMutation as never),
    runQuery: wrap(ctx.runQuery as never),
    runAction: wrap(ctx.runAction as never),
  } as ActionCtx;
  return {
    ctx: wrapped,
    kill: () => (dead = true),
    get dead() {
      return dead;
    },
  };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

export async function until(done: () => boolean, what = "condition") {
  for (let i = 0; i < 400; i++) {
    if (done()) return;
    await tick(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export type Queued = { threadId: string; promptId: string; key: string };

/** A prompt and the app's pending message after it, as a durable turn's key. */
export async function queue(ctx: ActionCtx, prompt = "go"): Promise<Queued> {
  const { threadId } = await agent.createThread(ctx, {});
  return queueIn(ctx, threadId, prompt);
}

export async function queueIn(
  ctx: ActionCtx,
  threadId: string,
  prompt = "go",
): Promise<Queued> {
  const { messageId: promptId } = await agent.saveMessage(ctx, {
    threadId,
    prompt,
  });
  const { messageId: key } = await agent.saveMessage(ctx, {
    threadId,
    promptMessageId: promptId,
    message: { role: "assistant", content: [] },
    metadata: { status: "pending" },
  });
  return { threadId, promptId, key };
}

export type Outcome =
  | { text: string; turn: unknown }
  | { refused: string; turn: unknown }
  | { error: string };

export async function outcome(p: Promise<{ text: string; turn?: unknown }>) {
  try {
    const r = await p;
    return { text: r.text, turn: r.turn } as Outcome;
  } catch (error) {
    if (error instanceof TurnError) return { refused: error.code } as Outcome;
    return { error: String((error as Error).message ?? error) } as Outcome;
  }
}

/**
 * Runs the turn once with generateText or streamText. "deltas" streams with a
 * short throttle, so the stream row exists while a tool runs.
 */
export async function attempt(
  ctx: ActionCtx,
  q: Queued,
  mode: "generate" | "stream" | "deltas" = "generate",
  extra: Record<string, unknown> = {},
  a: Agent = agent,
): Promise<{ text: string; turn?: unknown }> {
  if (mode === "generate") {
    return a.generateText(
      ctx,
      { threadId: q.threadId },
      { pendingMessageId: q.key, ...extra },
    );
  }
  const result = await a.streamText(
    ctx,
    { threadId: q.threadId },
    { pendingMessageId: q.key, ...extra },
    { saveStreamDeltas: { throttleMs: mode === "deltas" ? 1 : 60_000 } },
  );
  await result.consumeStream();
  const text = await result.text;
  return { text, turn: await (result as { turn?: unknown }).turn };
}

/** Waits until a stream row exists at `order`. */
export async function streamAt(
  ctx: ActionCtx,
  threadId: string,
  order: number,
) {
  for (let i = 0; i < 400; i++) {
    const streams = await ctx.runQuery(components.agent.streams.list, {
      threadId,
      startOrder: order,
      statuses: ["streaming"],
    });
    if (streams.some((s) => s.order === order)) return;
    await tick(5);
  }
  throw new Error("Timed out waiting for a stream");
}

export type Row = {
  id: string;
  order: number;
  stepOrder: number;
  status: string;
  role?: string;
  content?: unknown;
  error?: string;
};

export async function rows(ctx: ActionCtx, threadId: string): Promise<Row[]> {
  const { page } = await ctx.runQuery(
    components.agent.messages.listMessagesByThreadId,
    {
      threadId,
      order: "asc",
      statuses: ["pending", "success", "failed"],
      paginationOpts: { cursor: null, numItems: 100 },
    },
  );
  return page.map((m) => ({
    id: m._id,
    order: m.order,
    stepOrder: m.stepOrder,
    status: m.status,
    role: m.message?.role,
    content: m.message?.content,
    ...(m.error && { error: m.error }),
  }));
}

export function parts(saved: Pick<Row, "content">[], type: string) {
  return saved.flatMap((m) =>
    Array.isArray(m.content)
      ? (m.content as { type: string }[]).filter((p) => p.type === type)
      : [],
  );
}

// Past the 15-minute lease.
export const LEASE = 30 * 60 * 1000;

export const REFUSALS = ["TurnBusy", "TurnEnded"];

/** A step save: turns/saveStep, or addMessages where turns don't exist. */
export const isStepSave = (name: string) =>
  name === "messages/addMessages" || name === "turns/saveStep";

export { initConvexTest };
