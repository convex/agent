import { simulateReadableStream, stepCountIs } from "ai";
import { z } from "zod/v4";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { TransactionMetricsTracker } from "convex-test/dist/transactionMetrics.js";
import { Agent, createTool } from "../index.js";
import { components } from "./setup.test.js";
import { mockModel } from "./mockModel.js";
import type { ActionCtx } from "./types.js";
import { getFunctionName } from "convex/server";

function functionName(ref: unknown) {
  const path = (ref as Record<symbol, unknown>)[Symbol.for("toReferencePath")];
  if (typeof path === "string") return path.split("/").slice(-2).join("/");
  return getFunctionName(ref as never);
}

export type Cost = {
  mutations: number;
  queries: number;
  indexRanges: number;
  documentsRead: number;
  bytesRead: number;
  documentsWritten: number;
  bytesWritten: number;
  /**
   * Per component call, what it read and wrote, in order. A point read of a
   * document the call hasn't loaded yet costs a cold read on Convex cloud,
   * which convex-test doesn't model, so the order is pinned too.
   */
  calls: string[];
};

type Syscalls = {
  syscall: (op: string, args: string) => string;
  asyncSyscall: (op: string, args: string) => Promise<string>;
  jsSyscall: unknown;
};
const convexGlobal = globalThis as unknown as { Convex: Syscalls };
const tracker = TransactionMetricsTracker.prototype;
const original = {
  trackRead: tracker.trackRead,
  trackWrite: tracker.trackWrite,
  trackIndexRange: tracker.trackIndexRange,
};
let active:
  | { cost: Cost; trace: string[]; labels: Map<string, string> }
  | undefined;

function label(value: unknown, table?: string): string {
  if (typeof value !== "string" || !active) return JSON.stringify(value);
  const known = active.labels.get(value);
  if (known) return known;
  if (!table || !/^[a-z0-9]{20,}$/.test(value)) return JSON.stringify(value);
  const next = `${table}${[...active.labels.values()].filter((l) => l.startsWith(`${table}#`)).length + 1}`;
  const name = `${table}#${next.slice(table.length)}`;
  active.labels.set(value, name);
  return name;
}

function docLabel(doc: unknown, table: string) {
  const id = (doc as { _id?: string } | null)?._id;
  return id ? label(id, table) : "null";
}

function rangeText(
  range: { type: string; fieldPath: string; value: unknown }[],
) {
  return range
    .map((r) => {
      const value =
        r.fieldPath === "threadId"
          ? label(r.value, "threads")
          : r.fieldPath.endsWith("Id") || r.fieldPath === "_id"
            ? label(r.value, r.fieldPath.replace(/Id$/, "s"))
            : JSON.stringify(r.value);
      return `${r.fieldPath}${r.type === "Eq" ? "=" : ` ${r.type} `}${value}`;
    })
    .join(",");
}

function install() {
  const inner = convexGlobal.Convex;
  const queries = new Map<number, string>();
  convexGlobal.Convex = {
    get syscall() {
      const call = inner.syscall;
      return (op: string, jsonArgs: string) => {
        const result = call(op, jsonArgs);
        if (active && op === "1.0/queryStream") {
          const { query } = JSON.parse(jsonArgs);
          const source = query.source;
          const index: string = source.indexName ?? source.tableName;
          const table = index.split(".")[0];
          const { queryId } = JSON.parse(result);
          queries.set(queryId, table);
          active.trace.push(
            `q ${index.split(".")[1] ?? table}(${rangeText(source.range ?? [])})${source.order === "desc" ? " desc" : ""}`,
          );
        }
        return result;
      };
    },
    get asyncSyscall() {
      const call = inner.asyncSyscall;
      return async (op: string, jsonArgs: string) => {
        const args = JSON.parse(jsonArgs);
        const result = await call(op, jsonArgs);
        if (!active) return result;
        const trace = active.trace;
        switch (op) {
          case "1.0/get":
            trace.push(`get ${label(args.id, args.table)}`);
            break;
          case "1.0/queryStreamNext": {
            const { value, done } = JSON.parse(result);
            const table = queries.get(args.queryId) ?? "?";
            trace.push(done ? "  end" : `  ${docLabel(value, table)}`);
            break;
          }
          case "1.0/queryPage": {
            const { page } = JSON.parse(result);
            const index: string = args.query.source.indexName;
            const table = index.split(".")[0];
            trace.push(
              `page ${index.split(".")[1]} [${(page as unknown[]).map((d) => docLabel(d, table)).join(" ")}]`,
            );
            break;
          }
          case "1.0/insert":
            trace.push(`insert ${label(JSON.parse(result)._id, args.table)}`);
            break;
          case "1.0/shallowMerge":
            trace.push(`patch ${label(args.id, args.table)}`);
            break;
          case "1.0/replace":
            trace.push(`replace ${label(args.id, args.table)}`);
            break;
          case "1.0/remove":
            trace.push(`delete ${label(args.id, args.table)}`);
            break;
        }
        return result;
      };
    },
    get jsSyscall() {
      return inner.jsSyscall;
    },
  };
  return () => {
    convexGlobal.Convex = inner;
  };
}

/** Everything `run` does to the database, through the action's own calls. */
export async function measure(
  ctx: ActionCtx,
  run: (ctx: ActionCtx) => Promise<unknown>,
): Promise<Cost> {
  const cost: Cost = {
    mutations: 0,
    queries: 0,
    indexRanges: 0,
    documentsRead: 0,
    bytesRead: 0,
    documentsWritten: 0,
    bytesWritten: 0,
    calls: [],
  };
  const labels = active?.labels ?? new Map<string, string>();
  tracker.trackRead = function (size: number) {
    if (active) {
      active.cost.documentsRead++;
      active.cost.bytesRead += size;
    }
    return original.trackRead.call(this, size);
  };
  tracker.trackWrite = function (size: number) {
    if (active) {
      active.cost.documentsWritten++;
      active.cost.bytesWritten += size;
    }
    return original.trackWrite.call(this, size);
  };
  tracker.trackIndexRange = function () {
    if (active) active.cost.indexRanges++;
    return original.trackIndexRange.call(this);
  };
  const traced = <A extends unknown[], R>(
    kind: string,
    fn: (ref: never, args: never) => Promise<R>,
  ) =>
    (async (ref: never, args: never) => {
      if (kind !== "action")
        cost[kind === "mutation" ? "mutations" : "queries"]++;
      const trace: string[] = [];
      const outer = active;
      active = { cost, trace, labels };
      try {
        return await fn(ref, args);
      } finally {
        const name = functionName(ref);
        cost.calls.push(`${kind} ${name}: ${trace.join("; ")}`);
        active = outer;
      }
    }) as unknown as (...args: A) => Promise<R>;
  const counted = {
    ...ctx,
    runMutation: traced("mutation", ctx.runMutation as never),
    runQuery: traced("query", ctx.runQuery as never),
    runAction: traced("action", ctx.runAction as never),
  } as ActionCtx;
  const uninstall = install();
  try {
    await run(counted);
  } finally {
    uninstall();
    Object.assign(tracker, original);
  }
  return cost;
}

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

// Calls `tool` once per step until `steps` tool results follow the last
// user message, then answers.
export function scriptedAgent(
  steps: number,
  tool: "send" | "ask",
  beforeAnswer?: () => Promise<void>,
) {
  const respond = (
    options: LanguageModelV4CallOptions,
  ): LanguageModelV4GenerateResult => {
    const lastUser = options.prompt.map((m) => m.role).lastIndexOf("user");
    const done = options.prompt
      .slice(lastUser)
      .filter((m) => m.role === "tool").length;
    if (done >= steps) {
      return {
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    }
    return {
      content: [
        {
          type: "tool-call",
          toolCallId: `call-${done}`,
          toolName: tool,
          input: JSON.stringify({ q: String(done) }),
        },
      ],
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: USAGE,
      warnings: [],
    };
  };
  return new Agent(components.agent, {
    name: "cost",
    languageModel: mockModel({
      doGenerate: async (options) => {
        await beforeAnswer?.();
        return respond(options);
      },
      doStream: async (options) => {
        const { content, finishReason, usage } = respond(options);
        const chunks: LanguageModelV4StreamPart[] = [
          { type: "stream-start", warnings: [] },
          ...content.flatMap((part): LanguageModelV4StreamPart[] =>
            part.type === "text"
              ? [
                  { type: "text-start", id: "t" },
                  { type: "text-delta", id: "t", delta: part.text },
                  { type: "text-end", id: "t" },
                ]
              : part.type === "tool-call"
                ? [part]
                : [],
          ),
          { type: "finish", finishReason, usage },
        ];
        return { stream: simulateReadableStream({ chunks }) };
      },
    }),
    tools: {
      send: createTool({
        description: "A side effect",
        inputSchema: z.object({ q: z.string() }),
        execute: async (_ctx, { q }) => `sent ${q}`,
      }),
      ask: createTool({
        description: "Needs approval",
        inputSchema: z.object({ q: z.string() }),
        execute: async (_ctx, { q }) => `asked ${q}`,
        needsApproval: true,
      }),
    },
    stopWhen: stepCountIs(steps + 1),
  });
}
