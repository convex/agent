import type { FunctionHandle } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { finalizePending, getMaxMessage } from "./messages.js";
import {
  abortById,
  endStoppedStream,
  finishHandler,
  getStream,
  stopStream,
} from "./streams.js";

type Turn = Doc<"turns">;
type Row = Doc<"messages">;
type Stream = Doc<"streamingMessages">;
type Status = Row["status"];
type Role =
  | { kind: "app" }
  | { kind: "holder"; turn: Turn }
  // The job of a turn a stop ended.
  | { kind: "stopped"; turn: Turn }
  | { kind: "revoked" };
// `at` is the stamping turn's position, which decides a holding; it is never stored.
export type Stamp = { turnId?: Id<"turns">; jobId?: string; at?: At };
export type At = { threadId: Id<"threads">; order: number };
const atOf = (turn: Pick<Turn, "threadId" | "fromOrder">): At => ({
  threadId: turn.threadId,
  order: turn.fromOrder,
});
export type TurnInfo = {
  promptMessageId: Id<"messages">;
  jobId: string;
  /**
   * The steps its turn saved since its anchor, in order, which its job
   * resumes after.
   */
  saved: Row[];
};

export const REFUSED = "The generation was stopped or replaced";
export const DEFAULT_MAX_RETRIES = 2;
const TIMED_OUT = "timeout";

const live = (turn: Turn | null | undefined): turn is Turn =>
  !!turn && turn.status !== "done";
// A turn's position: its thread and order. Leased rows and streams elsewhere aren't at it.
const at = (turn: Turn) => (d: { threadId: Id<"threads">; order: number }) =>
  d.threadId === turn.threadId && d.order === turn.order;
const anchors = (turn: Turn, row: Row) =>
  row._id === turn.promptMessageId || row._id === turn.anchorMessageId;

export async function callerJob(ctx: MutationCtx): Promise<string | null> {
  return (await ctx.meta.getRequestMetadata()).scheduledFunctionId ?? null;
}

// resolve: an id from another thread reads as missing.
export async function resolve(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  messageId: Id<"messages">,
) {
  const row = await ctx.db.get("messages", messageId);
  return row && row.threadId === threadId ? row : null;
}

async function turnOf(ctx: MutationCtx, doc: { turnId?: Id<"turns"> }) {
  return doc.turnId ? await ctx.db.get("turns", doc.turnId) : null;
}

// authorize: the only ownership decision.
async function roleOf(
  ctx: MutationCtx,
  caller: string | null,
  hint?: Turn | null,
): Promise<Role> {
  if (!caller) return { kind: "app" };
  if (hint && hint.jobId === caller) return jobRole(hint);
  const job = await ctx.db
    .query("jobs")
    .withIndex("jobId", (q) => q.eq("jobId", caller))
    .first();
  if (!job) return { kind: "app" };
  const turn = await ctx.db.get("turns", job.turnId);
  if (!turn || turn.jobId !== caller) return { kind: "revoked" };
  return jobRole(turn);
}

// A stop keeps the turn's job, so the stopped job is told apart from a replaced one.
function jobRole(turn: Turn): Role {
  if (turn.status !== "done") return { kind: "holder", turn };
  return turn.outcome === "stopped"
    ? { kind: "stopped", turn }
    : { kind: "app" };
}

type Write =
  | { as: "turn"; turnId: Id<"turns">; caller: string }
  // A stopped job's save into its own stopped open row: that row's ending.
  | { as: "ending"; turnId: Id<"turns">; caller: string }
  // A stopped job's write after its row ended: a no-op.
  | { as: "stopped" }
  | { as: "app"; liveTurn?: Turn };

/** Who may write an existing row: its turn's job, the app, or no one. */
export async function authorizeRow(ctx: MutationCtx, row: Row) {
  const write = await authorizeEnding(ctx, row);
  if (write.as === "ending" || write.as === "stopped") throw new Error(REFUSED);
  return write;
}

/** authorizeRow for a write that closes the row, which a stopped job may make once. */
export async function authorizeEnding(
  ctx: MutationCtx,
  row: Row,
): Promise<Write> {
  const caller = await callerJob(ctx);
  // handOff changes a row's job copy with its turn's job, so a match is the
  // holder, or, on a row its stop marked, the stopped job ending it.
  if (caller && row.jobId === caller) {
    return { as: row.abort ? "ending" : "turn", turnId: row.turnId!, caller };
  }
  const turn = await turnOf(ctx, row);
  const role = await roleOf(ctx, caller, turn);
  if (role.kind === "revoked") throw new Error(REFUSED);
  if (role.kind === "stopped") {
    if (role.turn._id !== row.turnId) throw new Error(REFUSED);
    return { as: "stopped" };
  }
  if (!live(turn)) return { as: "app" };
  if (role.kind === "holder" && role.turn._id === turn._id) {
    return { as: "turn", turnId: turn._id, caller: caller! };
  }
  if (role.kind === "holder") throw new Error(REFUSED);
  return { as: "app", liveTurn: turn };
}

/** A durable stream takes writes only from the job it was opened for, while it streams. */
export async function authorizeStream(ctx: MutationCtx, stream: Stream) {
  if (stream.jobId === undefined) return;
  if (
    stream.state.kind !== "streaming" ||
    stream.jobId !== (await callerJob(ctx))
  ) {
    throw new Error(REFUSED);
  }
}

/** Records a stamped row or stream that sits outside its turn's thread from its fromOrder. */
export async function hold(
  ctx: MutationCtx,
  stamp: Stamp,
  doc: At,
  ref: { messageId: Id<"messages"> } | { streamId: Id<"streamingMessages"> },
) {
  const { turnId, at } = stamp;
  if (!turnId || !at || within(at, doc)) return;
  await ctx.db.insert("holdings", { turnId, threadId: at.threadId, ...ref });
}

const within = (at: At, doc: At) =>
  doc.threadId === at.threadId && doc.order >= at.order;

/** A turn's held docs of one table the thread range does not already reach. */
async function held<T extends Row | Stream>(
  ctx: MutationCtx,
  turn: Turn,
  get: (h: Doc<"holdings">) => Promise<T | null>,
  keep: (doc: T) => boolean,
) {
  const holdings = await ctx.db
    .query("holdings")
    .withIndex("turnId", (q) => q.eq("turnId", turn._id))
    .collect();
  const docs: T[] = [];
  for (const h of holdings) {
    const doc = await get(h);
    if (
      doc &&
      doc.turnId === turn._id &&
      !within(atOf(turn), doc) &&
      keep(doc)
    ) {
      docs.push(doc);
    }
  }
  return docs;
}

// members: the only enumerator of a turn's rows and streams: its thread's own
// indexes from its fromOrder, plus its holdings. Plain rows pay for neither.
async function members(
  ctx: MutationCtx,
  turn: Turn,
  status: Status,
  since?: "anchor",
) {
  const lists = await Promise.all(
    [false, true].map((tool) =>
      ctx.db
        .query("messages")
        .withIndex("threadId_status_tool_order_stepOrder", (q) => {
          const base = q
            .eq("threadId", turn.threadId)
            .eq("status", status)
            .eq("tool", tool);
          return since
            ? base.eq("order", turn.order).gt("stepOrder", turn.anchorStepOrder)
            : base.gte("order", turn.fromOrder);
        })
        .collect(),
    ),
  );
  const near = lists.flat().filter((row) => row.turnId === turn._id);
  if (since) return near;
  const away = await held(
    ctx,
    turn,
    async (h) => (h.messageId ? ctx.db.get("messages", h.messageId) : null),
    (row) => row.status === status,
  );
  return [...near, ...away];
}

async function memberStreams(
  ctx: MutationCtx,
  turn: Turn,
  kind: Stream["state"]["kind"],
) {
  const near = (
    await ctx.db
      .query("streamingMessages")
      .withIndex("threadId_state_order_stepOrder", (q) =>
        q
          .eq("threadId", turn.threadId)
          .eq("state.kind", kind)
          .gte("order", turn.fromOrder),
      )
      .collect()
  ).filter((s) => s.turnId === turn._id);
  const away = await held(
    ctx,
    turn,
    async (h) =>
      h.streamId ? ctx.db.get("streamingMessages", h.streamId) : null,
    (stream) => stream.state.kind === kind,
  );
  return [...near, ...away];
}

// A turn's newest step at its position, newest first: its newest settled
// member and, after a tool result, every row back to the call row, since a
// step's results may be saved one at a time.
async function newestStep(ctx: MutationCtx, turn: Turn, since?: "anchor") {
  const ranges = (["success", "failed"] as const).flatMap((status) =>
    [false, true].map((tool) => {
      const range = ctx.db
        .query("messages")
        .withIndex("threadId_status_tool_order_stepOrder", (q) => {
          const base = q
            .eq("threadId", turn.threadId)
            .eq("status", status)
            .eq("tool", tool)
            .eq("order", turn.order);
          return since ? base.gt("stepOrder", turn.anchorStepOrder) : base;
        })
        .order("desc");
      return range[Symbol.asyncIterator]();
    }),
  );
  const next = async (range: (typeof ranges)[number]) => {
    for (let r = await range.next(); !r.done; r = await range.next()) {
      if (r.value.turnId === turn._id) return r.value;
    }
    return null;
  };
  const heads = await Promise.all(ranges.map(next));
  const step: Row[] = [];
  for (;;) {
    const i = heads.reduce<number>(
      (best, row, j) =>
        row && (best < 0 || row.stepOrder > heads[best]!.stepOrder) ? j : best,
      -1,
    );
    if (i < 0) break;
    step.push(heads[i]!);
    if (heads[i]!.message?.role !== "tool") break;
    heads[i] = await next(ranges[i]);
  }
  return step;
}

type Part = { type: string; toolCallId?: string; approvalId?: string };
const partsOf = (row: Row): Part[] =>
  Array.isArray(row.message?.content) ? (row.message.content as Part[]) : [];

type Detected =
  | { kind: "open" | "none" | "answered" | "failed" }
  | { kind: "waiting"; requestMessageId: Id<"messages"> };

// detect: the only answer detector.
async function detect(
  ctx: MutationCtx,
  turn: Turn,
  wroteFailed: boolean,
  saved: Row[] = [],
): Promise<Detected> {
  if (wroteFailed) return { kind: "failed" };
  const atOrder = at(turn);
  const open = (row: Row) =>
    row.status === "pending" && row.turnId === turn._id && atOrder(row);
  if (saved.some(open)) return { kind: "open" };
  if ((await members(ctx, turn, "pending")).some(atOrder)) {
    return { kind: "open" };
  }
  if ((await memberStreams(ctx, turn, "streaming")).some(atOrder)) {
    return { kind: "open" };
  }
  const step = await newestStep(ctx, turn, "anchor");
  const last = step[0];
  if (!last) {
    const finished = (await memberStreams(ctx, turn, "finished")).some(
      (s) => atOrder(s) && s.jobId === turn.jobId,
    );
    return { kind: finished ? "answered" : "none" };
  }
  if (last.status === "failed") return { kind: "failed" };
  // Only the model's own step answers: a user or system row leaves it open.
  const role = last.message?.role;
  if (role !== "assistant" && role !== "tool") return { kind: "none" };
  const rows = step
    .filter(
      (row, i) => i < step.length - 1 || row.message?.role === "assistant",
    )
    .reverse();
  const calls = new Map<string, Id<"messages">>();
  const requests = new Map<string, { call: string; row: Id<"messages"> }>();
  for (const row of rows) {
    for (const part of partsOf(row)) {
      if (part.type === "tool-call") calls.set(part.toolCallId!, row._id);
      if (part.type === "tool-result") calls.delete(part.toolCallId!);
      if (part.type === "tool-approval-request") {
        requests.set(part.approvalId!, {
          call: part.toolCallId!,
          row: row._id,
        });
      }
      if (part.type === "tool-approval-response") {
        const request = requests.get(part.approvalId!);
        if (request) calls.delete(request.call);
        requests.delete(part.approvalId!);
      }
    }
  }
  const unresolved =
    [...requests.values()].at(-1)?.row ?? [...calls.values()].at(-1);
  return unresolved
    ? { kind: "waiting", requestMessageId: unresolved }
    : { kind: "answered" };
}

type Ending =
  | "stopped"
  | "superseded"
  | "takenOver"
  | "deleted"
  | "failed"
  | "answered"
  | "unanswered"
  | "exhausted";
type To =
  | { job: string; generate?: string; anchor?: Row; newRow?: true }
  | { waiting: Id<"messages"> }
  | { resumed: true }
  | { idle: true }
  | { end: Ending; byOwnJob: boolean; reason?: string };

const REASONS: Record<Ending, string> = {
  stopped: "Stopped",
  superseded: "Superseded by a newer generation",
  takenOver: "Restarting",
  deleted: "Message deleted",
  failed: "The generation failed",
  answered: "answered",
  unanswered: "The generation returned without answering",
  exhausted: "The generation failed after its retries",
};

type Result = { status: "success" } | { status: "failed"; error: string };

/** A stopped reply ends as main ends a stopped plain one: failed, keeping what it streamed. */
export const stoppedEnding = (row: Row) => ({
  status: "failed" as const,
  error: row.abort?.reason ?? REASONS.stopped,
});

async function closeRow(
  ctx: MutationCtx,
  row: Row,
  result: Result,
  abort?: { reason: string },
) {
  await finalizePending(
    ctx,
    row,
    result,
    undefined,
    row.streamId ? [row.streamId] : [],
  );
  if (abort) await ctx.db.patch("messages", row._id, { abort });
}

async function closeStream(
  ctx: MutationCtx,
  streamId: Id<"streamingMessages">,
  finished: boolean,
  reason: string,
) {
  // Read here: closing a row can close its stream after the caller read it.
  const stream = await getStream(ctx, streamId);
  if (finished) await finishHandler(ctx, stream);
  else await abortById(ctx, stream, { reason });
}

// handOff: the only writer of a turn's job and status, and of a row's job copy.
async function handOff(ctx: MutationCtx, turn: Turn, to: To) {
  if ("waiting" in to || "resumed" in to) {
    await ctx.db.patch(
      "turns",
      turn._id,
      "waiting" in to
        ? { status: "waiting", requestMessageId: to.waiting }
        : { status: "running", requestMessageId: undefined },
    );
    return;
  }
  const openRows = await members(ctx, turn, "pending");
  const openStreams = await memberStreams(ctx, turn, "streaming");
  const atOrder = at(turn);
  if ("idle" in to) {
    for (const s of openStreams)
      await closeStream(ctx, s._id, false, TIMED_OUT);
    for (const row of openRows) {
      await closeRow(ctx, row, { status: "failed", error: TIMED_OUT });
    }
    await ctx.db.patch("turns", turn._id, { jobId: undefined });
    return;
  }
  const running =
    !("end" in to && to.byOwnJob) && (await cancelQueued(ctx, turn));
  // A stop reads no deltas while another caller's job may still stream into
  // any open member, wherever it sits: the job's next save into the marked row
  // ends it, or its stream's own close, timeout, or a retry does. Rows without
  // a stream have no deltas to race.
  const leftToJob =
    "end" in to &&
    to.end === "stopped" &&
    running &&
    (await callerJob(ctx)) !== turn.jobId
      ? openRows.filter((row) => row.streamId)
      : [];
  const leftStreams = new Set(leftToJob.map((row) => row.streamId));
  if ("job" in to) {
    for (const s of openStreams)
      await closeStream(ctx, s._id, false, "Retried");
    for (const row of openRows) {
      if (atOrder(row)) {
        await ctx.db.patch("messages", row._id, {
          jobId: to.job,
          streamId: undefined,
        });
      } else {
        await closeRow(ctx, row, { status: "failed", error: "Retried" });
      }
    }
    if (to.newRow) {
      for (const row of await members(ctx, turn, "failed", "anchor")) {
        if (row.error === TIMED_OUT) await ctx.db.delete("messages", row._id);
      }
    }
    await ctx.db.patch("turns", turn._id, {
      jobId: to.job,
      status: "running",
      requestMessageId: undefined,
      ...(to.generate ? { generate: to.generate } : {}),
      ...(to.anchor
        ? {
            anchorMessageId: to.anchor._id,
            anchorStepOrder: to.anchor.stepOrder,
          }
        : { retries: turn.retries + 1 }),
    });
    return;
  }
  const { end, byOwnJob } = to;
  const reason = to.reason ?? REASONS[end];
  for (const row of openRows) {
    if (leftToJob.includes(row)) {
      await ctx.db.patch("messages", row._id, { abort: { reason } });
      await ctx.db.insert("leftOpen", {
        threadId: row.threadId,
        messageId: row._id,
        streamId: row.streamId!,
      });
      continue;
    }
    if (!atOrder(row) && byOwnJob) {
      await ctx.db.patch("messages", row._id, { jobId: undefined });
    } else if (end === "answered") {
      await closeRow(ctx, row, { status: "success" });
    } else if (end === "stopped") {
      await closeRow(ctx, row, { status: "failed", error: reason }, { reason });
    } else {
      await closeRow(ctx, row, { status: "failed", error: reason });
    }
  }
  for (const s of openStreams) {
    if (leftStreams.has(s._id)) await stopStream(ctx, s, reason);
    else await closeStream(ctx, s._id, end === "answered", reason);
  }
  if (end === "stopped" && !openRows.some(atOrder)) {
    const [newest] = await newestStep(ctx, turn);
    if (newest) {
      await ctx.db.patch("messages", newest._id, { abort: { reason } });
    }
  }
  if (end === "unanswered" && !openRows.some(atOrder)) {
    await failedReply(ctx, turn, reason);
  }
  await ctx.db.patch("turns", turn._id, {
    status: "done",
    outcome: end,
    jobId: byOwnJob || end === "stopped" ? turn.jobId : undefined,
  });
}

/** A turn whose job left nothing to show its failure on gets a failed reply. */
async function failedReply(ctx: MutationCtx, turn: Turn, error: string) {
  const prompt = await ctx.db.get("messages", turn.promptMessageId);
  const last = await getMaxMessage(ctx, turn.threadId, turn.order);
  await ctx.db.insert("messages", {
    threadId: turn.threadId,
    order: turn.order,
    stepOrder: (last?.stepOrder ?? turn.anchorStepOrder) + 1,
    userId: prompt?.userId,
    message: { role: "assistant", content: [] },
    tool: false,
    status: "failed",
    error,
    turnId: turn._id,
  });
}

async function jobState(ctx: MutationCtx, turn: Turn) {
  if (!turn.jobId) return undefined;
  const job = await ctx.db.system.get(
    "_scheduled_functions",
    turn.jobId as Id<"_scheduled_functions">,
  );
  return job?.state.kind;
}

/** Cancels a turn's job before it runs; returns whether it may still be running. */
async function cancelQueued(ctx: MutationCtx, turn: Turn) {
  if (!turn.jobId) return false;
  const job = await ctx.db.system.get(
    "_scheduled_functions",
    turn.jobId as Id<"_scheduled_functions">,
  );
  if (job?.state.kind === "pending") await ctx.scheduler.cancel(job._id);
  return job?.state.kind === "inProgress";
}

// schedule: the only scheduler of a turn's jobs. A new turn records its
// first job once it exists, so the turn is inserted with its job.
async function schedule(
  ctx: MutationCtx,
  turn: Pick<Turn, "threadId" | "generate"> & { _id?: Id<"turns"> },
  anchor: Id<"messages">,
) {
  const jobId: string = await ctx.scheduler.runAfter(
    0,
    turn.generate as FunctionHandle<"action">,
    { threadId: turn.threadId, promptMessageId: anchor },
  );
  if (turn._id) await recordJob(ctx, jobId, turn._id, turn.threadId);
  return jobId;
}

function recordJob(
  ctx: MutationCtx,
  jobId: string,
  turnId: Id<"turns">,
  threadId: Id<"threads">,
) {
  return ctx.db.insert("jobs", { jobId, turnId, threadId });
}

const DELETE_PAGE = 100;

/**
 * A deleted thread's turns, jobs and holdings go a page at a time; done once none are left.
 * A job's record outlives its turn while the job runs, so the job reads as revoked: one
 * record is left per job still running at deletion. Jobs page by cursor, so those records
 * never fill every page.
 */
export async function deleteTurnsPage(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  jobsCursor: string | undefined,
) {
  const turns = await ctx.db
    .query("turns")
    .withIndex("threadId_status_order", (q) => q.eq("threadId", threadId))
    .take(DELETE_PAGE);
  const jobs = await ctx.db
    .query("jobs")
    .withIndex("threadId", (q) => q.eq("threadId", threadId))
    .paginate({ numItems: DELETE_PAGE, cursor: jobsCursor ?? null });
  const holdings = await ctx.db
    .query("holdings")
    .withIndex("threadId", (q) => q.eq("threadId", threadId))
    .take(DELETE_PAGE);
  for (const turn of turns) await ctx.db.delete("turns", turn._id);
  for (const job of jobs.page) {
    const id = ctx.db.system.normalizeId("_scheduled_functions", job.jobId);
    const fn = id && (await ctx.db.system.get("_scheduled_functions", id));
    if (fn?.state.kind === "inProgress") continue;
    if (fn?.state.kind === "pending") await ctx.scheduler.cancel(id!);
    await ctx.db.delete("jobs", job._id);
  }
  for (const held of holdings) await ctx.db.delete("holdings", held._id);
  return {
    done:
      turns.length < DELETE_PAGE &&
      jobs.isDone &&
      holdings.length < DELETE_PAGE,
    jobsCursor: jobs.continueCursor,
  };
}

type Settle = {
  byApp: boolean;
  wroteFailed?: boolean;
  // The rows the write saved, which detect reads before the turn's members.
  saved?: Row[];
  reason?: string;
  continueWith?: { generate: string; anchor: Row };
};

/** The epilogue of every mutation that writes a live turn's member. */
export async function settle(
  ctx: MutationCtx,
  // A turn read earlier in this mutation, before any of its handOffs, or its id.
  turnOrId: Id<"turns"> | Turn,
  w: Settle,
): Promise<string | undefined> {
  const turn =
    typeof turnOrId === "string"
      ? await ctx.db.get("turns", turnOrId)
      : turnOrId;
  if (!live(turn)) return;
  const result = await detect(ctx, turn, !!w.wroteFailed, w.saved);
  if (result.kind === "open" || result.kind === "none") {
    if (turn.status === "waiting") await handOff(ctx, turn, { resumed: true });
    return;
  }
  if (result.kind === "waiting") {
    await handOff(ctx, turn, { waiting: result.requestMessageId });
    return;
  }
  if (result.kind === "answered" && w.continueWith) {
    const { generate, anchor } = w.continueWith;
    const jobId = await schedule(ctx, { ...turn, generate }, anchor._id);
    await handOff(ctx, turn, { job: jobId, generate, anchor });
    return jobId;
  }
  await handOff(ctx, turn, {
    end: result.kind,
    byOwnJob: !w.byApp,
    reason: w.reason,
  });
}

// turnsOf: the only lookup of turns by position. Live ones, or with `newest`
// the newest of each status, done included.
async function turnsOf(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  order?: number,
  newest?: "newest",
) {
  const statuses = newest
    ? (["running", "waiting", "done"] as const)
    : (["running", "waiting"] as const);
  const lists = await Promise.all(
    statuses.map((status) => {
      const range = ctx.db
        .query("turns")
        .withIndex("threadId_status_order", (q) => {
          const base = q.eq("threadId", threadId).eq("status", status);
          return order === undefined ? base : base.eq("order", order);
        });
      return newest ? range.order("desc").take(1) : range.collect();
    }),
  );
  return lists.flat();
}

/** The turn a row names: the newest live one it prompts, else its own. */
async function turnFor(ctx: MutationCtx, row: Row) {
  return (await turnsPromptedBy(ctx, row)).at(-1) ?? (await turnOf(ctx, row));
}

/**
 * Every live turn a row prompts or resumes from, its own included, oldest
 * first. A send leaves an existing prompt's stamp alone, so this is by position.
 */
async function turnsPromptedBy(ctx: MutationCtx, row: Row) {
  return (await turnsOf(ctx, row.threadId, row.order))
    .filter((turn) => anchors(turn, row))
    .sort((a, b) => a._creationTime - b._creationTime);
}

/** An open row a stop left to its running job, which keeps its job copy. */
export const stoppedOpen = (row: Row) =>
  row.status === "pending" && !!row.abort && row.jobId !== undefined;

/** A row leaving pending drops its left-open record; plain rows never have one. */
export async function leavePending(ctx: MutationCtx, row: Row) {
  if (!stoppedOpen(row)) return;
  const left = await ctx.db
    .query("leftOpen")
    .withIndex("messageId", (q) => q.eq("messageId", row._id))
    .unique();
  if (left) await ctx.db.delete("leftOpen", left._id);
}

/**
 * endStopped: the only ending of a stopped open row but its job's own save.
 * Its stream was aborted by the stop, so its delta log is frozen and reading
 * it here races no writer.
 */
export async function endStopped(ctx: MutationCtx, row: Row) {
  await closeRow(ctx, row, stoppedEnding(row));
  if (row.streamId) await endStoppedStream(ctx, row.streamId);
}

async function endStoppedMembers(ctx: MutationCtx, turn: Turn) {
  for (const row of await members(ctx, turn, "pending")) {
    if (stoppedOpen(row)) await endStopped(ctx, row);
  }
}

/** A new prompt in a thread ends the stopped open rows in it first, as F1 ends superseded turns. */
export async function endStoppedInThread(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  order?: number,
) {
  const left = await ctx.db
    .query("leftOpen")
    .withIndex("threadId", (q) => q.eq("threadId", threadId))
    .collect();
  for (const { messageId } of left) {
    const row = (await ctx.db.get("messages", messageId))!;
    if (order === undefined || row.order === order) await endStopped(ctx, row);
  }
}

async function newestTurn(ctx: MutationCtx, threadId: Id<"threads">) {
  return (
    (await turnsOf(ctx, threadId, undefined, "newest"))
      .sort((a, b) => a.order - b.order || a._creationTime - b._creationTime)
      .at(-1) ?? null
  );
}

/** A send ends the live turns it replaces: running at its order, or waiting at or before it. */
async function supersede(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  order: number | undefined,
  caller: string | null,
) {
  for (const turn of await turnsOf(ctx, threadId)) {
    if (caller && turn.jobId === caller) continue;
    // D6: a running turn elsewhere is left to its job or its retry.
    const replaced =
      turn.status === "running"
        ? turn.order === order
        : order === undefined || turn.order <= order;
    if (replaced) {
      await handOff(ctx, turn, { end: "superseded", byOwnJob: false });
    }
  }
}

/** A generation begun at a prompt takes over every live turn it prompts but the caller's own. */
async function takeOver(ctx: MutationCtx, prompted: Turn[], role: Role) {
  for (const turn of prompted) {
    if (role.kind === "holder" && role.turn._id === turn._id) continue;
    await handOff(ctx, turn, { end: "takenOver", byOwnJob: false });
  }
}

/** How one save takes part in turns, decided before it writes anything. */
export type SaveTurn = {
  pending?: Row | null;
  stamp?: (order: number, status: Status, replaced?: Row) => Stamp;
  streamStamp?: Stamp;
  unlinked?: boolean;
  // The open row's stream, handed to the next open row a step save inserts.
  carry?: Id<"streamingMessages">;
  // The turn's prompt's user, whom its job's saves act for.
  userId?: string;
  // A stopped job's last save: trailing open rows and new streams are dropped.
  ending?: true;
  // A stopped job's save into a row that already ended: nothing is written.
  stopped?: true;
  adopt?: { row: Row; turn: Turn; caller: string };
  after?: (
    saved: Row[],
    streamId?: Id<"streamingMessages">,
    // The stream the save itself finished or aborted.
    finished?: Id<"streamingMessages">,
  ) => Promise<{ jobId?: string; turn?: TurnInfo }>;
};

const turnInfo = async (
  ctx: MutationCtx,
  turn: Turn,
  jobId: string,
): Promise<TurnInfo> => ({
  promptMessageId: turn.promptMessageId,
  jobId,
  saved: (await members(ctx, turn, "success", "anchor")).sort(
    (a, b) => a.order - b.order || a.stepOrder - b.stepOrder,
  ),
});

type Position = Pick<Turn, "_id" | "threadId" | "order" | "fromOrder">;

/** A holder's rows at its turn are members; elsewhere only its open rows are leased. */
function memberStamp(turn: Position, caller: string, threadId: Id<"threads">) {
  return (order: number, status: Status, replaced?: Row): Stamp => {
    const job = status === "pending" ? { jobId: caller } : {};
    if (replaced) return { turnId: replaced.turnId, ...job };
    const stamp = { turnId: turn._id, ...job, at: atOf(turn) };
    if (threadId !== turn.threadId || order !== turn.order) {
      return status === "pending" ? stamp : {};
    }
    return stamp;
  };
}

/** A job's fill target, read once; `own` when its job copy is the caller's, so nothing else need be read. */
export async function jobFillTarget(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  pendingMessageId?: Id<"messages">,
) {
  if (!pendingMessageId) return undefined;
  const caller = await callerJob(ctx);
  if (!caller) return undefined;
  const row = await resolve(ctx, threadId, pendingMessageId);
  return { row, own: !!row?.turnId && row.jobId === caller };
}

export async function planSave(
  ctx: MutationCtx,
  args: {
    threadId: Id<"threads">;
    generate?: string;
    promptMessage?: Row | null;
    pendingMessageId?: Id<"messages">;
    pendingMessage?: Row | null;
    order?: number | "next";
    messages: { status?: Status }[];
  },
): Promise<SaveTurn> {
  const caller = await callerJob(ctx);
  const pending =
    args.pendingMessage !== undefined
      ? args.pendingMessage
      : args.pendingMessageId
        ? await resolve(ctx, args.threadId, args.pendingMessageId)
        : undefined;
  if (args.generate !== undefined) {
    if (args.pendingMessageId) {
      throw new Error("generate and pendingMessageId cannot both be provided");
    }
    return planSend(ctx, { ...args, generate: args.generate }, caller);
  }
  const beginning =
    args.messages.length === 1 && args.messages[0].status === "pending";
  if (pending) {
    const write = await authorizeEnding(ctx, pending);
    if (!pending.turnId) return { pending, carry: pending.streamId };
    if (write.as === "ending") return planEnding(ctx, pending, write.turnId);
    if (write.as === "stopped") return { pending, stopped: true };
    if (
      write.as === "turn" || write.liveTurn
        ? args.promptMessage && args.promptMessage.order !== pending.order
        : false
    ) {
      throw new Error("A live turn's reply can't move to another prompt");
    }
    return planFill(ctx, pending, write, args.promptMessage);
  }
  if (!caller && !args.promptMessage?.turnId) return { pending };
  const prompt = args.promptMessage ?? null;
  const prompted = prompt ? await turnsPromptedBy(ctx, prompt) : [];
  const promptTurn =
    prompted.at(-1) ?? (prompt ? await turnOf(ctx, prompt) : null);
  const role = await roleOf(ctx, caller, promptTurn);
  if (role.kind === "revoked" || role.kind === "stopped") {
    throw new Error(REFUSED);
  }
  if (beginning) await takeOver(ctx, prompted, role);
  if (role.kind !== "holder") return { pending };
  const turn = role.turn;
  const own = caller!;
  const atTurn =
    turn.threadId === args.threadId &&
    (prompt ? prompt.order === turn.order : args.order === turn.order);
  if (!atTurn) return { pending, ...lease(turn, own) };
  const userId =
    prompt?._id === turn.promptMessageId
      ? prompt.userId
      : await promptUser(ctx, turn);
  if (prompt && beginning && anchors(turn, prompt)) {
    const [open] = (await members(ctx, turn, "pending")).filter(at(turn));
    if (open) {
      return { pending, userId, adopt: { row: open, turn, caller: own } };
    }
  }
  return {
    pending,
    userId,
    stamp: memberStamp(turn, own, args.threadId),
    streamStamp: { turnId: turn._id, jobId: own, at: atOf(turn) },
    after: async (saved) => {
      await settle(ctx, beginning ? turn : turn._id, { byApp: false, saved });
      return beginning ? { turn: await turnInfo(ctx, turn, own) } : {};
    },
  };
}

/** Whatever a job opens away from its turn is still its own, so ending its turn closes it. */
function lease(turn: Turn, caller: string): SaveTurn {
  const stamp = { turnId: turn._id, jobId: caller, at: atOf(turn) };
  return {
    stamp: (_order, status) => (status === "pending" ? stamp : {}),
    streamStamp: stamp,
  };
}

async function promptUser(ctx: MutationCtx, turn: Turn) {
  return (await ctx.db.get("messages", turn.promptMessageId))?.userId;
}

/** The lease for a stream a caller opens: the turn its job holds, if any. */
export async function streamLease(ctx: MutationCtx): Promise<Stamp> {
  const caller = await callerJob(ctx);
  if (!caller) return {};
  const role = await roleOf(ctx, caller);
  if (role.kind === "revoked" || role.kind === "stopped") {
    throw new Error(REFUSED);
  }
  return role.kind === "holder"
    ? { turnId: role.turn._id, jobId: caller, at: atOf(role.turn) }
    : {};
}

// A holder's turn's position, from its prompt when the save names it.
async function positionOf(
  ctx: MutationCtx,
  turnId: Id<"turns">,
  prompt?: Row | null,
): Promise<Position> {
  if (prompt?.turnId === turnId && prompt.status !== "pending") {
    // The prompt's order bounds fromOrder from above, so a holding is never missed.
    return {
      _id: turnId,
      threadId: prompt.threadId,
      order: prompt.order,
      fromOrder: prompt.order,
    };
  }
  return (await ctx.db.get("turns", turnId))!;
}

async function planFill(
  ctx: MutationCtx,
  pending: Row,
  write: Exclude<Write, { as: "ending" | "stopped" }>,
  prompt?: Row | null,
): Promise<SaveTurn> {
  const turnId = write.as === "turn" ? write.turnId : write.liveTurn?._id;
  const position =
    write.as === "turn" ? await positionOf(ctx, write.turnId, prompt) : null;
  return {
    pending,
    userId: turnId ? pending.userId : undefined,
    carry: turnId ? pending.streamId : undefined,
    stamp:
      write.as === "turn"
        ? memberStamp(position!, write.caller, pending.threadId)
        : (_order, status, replaced) =>
            replaced || status !== "pending" ? { turnId: pending.turnId } : {},
    streamStamp:
      write.as === "turn"
        ? { turnId: write.turnId, jobId: write.caller, at: atOf(position!) }
        : undefined,
    after: async (saved, _streamId, finished) => {
      const row = saved.find((doc) => doc._id === pending._id);
      const carried = saved.some(
        (doc) => doc._id !== pending._id && doc.streamId === pending.streamId,
      );
      if (
        pending.streamId &&
        pending.streamId !== finished &&
        row &&
        row.status !== "pending" &&
        !carried
      ) {
        await closeStream(
          ctx,
          pending.streamId,
          row.status === "success",
          "Filled",
        );
      }
      if (!turnId) return {};
      // The turn positionOf read, if it read one: no save writes a turn.
      const read = position && "status" in position ? (position as Turn) : null;
      await settle(
        ctx,
        write.as === "app" ? write.liveTurn! : (read ?? turnId),
        {
          byApp: write.as === "app",
          wroteFailed: saved.some((doc) => doc.status === "failed"),
          saved,
        },
      );
      return {};
    },
  };
}

/** A stopped job's save into its own stopped row ends it: no next step. */
async function planEnding(
  ctx: MutationCtx,
  pending: Row,
  turnId: Id<"turns">,
): Promise<SaveTurn> {
  const turn = (await ctx.db.get("turns", turnId))!;
  return {
    pending,
    ending: true,
    userId: pending.userId,
    stamp: (order, _status, replaced) =>
      replaced || (pending.threadId === turn.threadId && order === turn.order)
        ? { turnId }
        : {},
    after: async (_saved, _streamId, finished) => {
      for (const streamId of new Set([pending.streamId, finished])) {
        if (streamId) await endStoppedStream(ctx, streamId);
      }
      return {};
    },
  };
}

async function planSend(
  ctx: MutationCtx,
  args: {
    threadId: Id<"threads">;
    generate: string;
    promptMessage?: Row | null;
    order?: number | "next";
  },
  caller: string | null,
): Promise<SaveTurn> {
  const role = await roleOf(ctx, caller);
  if (role.kind === "revoked" || role.kind === "stopped") {
    throw new Error(REFUSED);
  }
  const order =
    args.promptMessage?.order ??
    (typeof args.order === "number" ? args.order : undefined);
  await supersede(ctx, args.threadId, order, caller);
  // A job's send at its own order streams as the job, not as the new turn.
  const sender =
    role.kind === "holder" &&
    role.turn.threadId === args.threadId &&
    role.turn.order === order
      ? { turnId: role.turn._id, jobId: caller! }
      : undefined;
  return {
    streamStamp: sender,
    unlinked: !!sender,
    after: async (saved, streamId) => {
      const prompt =
        args.promptMessage ??
        [...saved].reverse().find((row) => row.status !== "pending") ??
        saved[0];
      if (!prompt) throw new Error("A send needs a prompt to answer");
      const jobId = await schedule(ctx, args, prompt._id);
      const turnId = await ctx.db.insert("turns", {
        jobId,
        threadId: args.threadId,
        order: prompt.order,
        fromOrder: Math.min(prompt.order, ...saved.map((row) => row.order)),
        promptMessageId: prompt._id,
        anchorMessageId: prompt._id,
        // A pending anchor is the reply itself, so it counts as a member.
        anchorStepOrder:
          prompt.status === "pending" ? prompt.stepOrder - 1 : prompt.stepOrder,
        generate: args.generate,
        retries: 0,
        status: "running",
      });
      await recordJob(ctx, jobId, turnId, args.threadId);
      // Stamped in the save's own transaction: the turn needs the rows' ids.
      // A send never restamps a row: an existing prompt keeps its turn.
      const stamped =
        args.promptMessage && !args.promptMessage.turnId
          ? [args.promptMessage, ...saved]
          : saved;
      for (const row of stamped) {
        await ctx.db.patch("messages", row._id, {
          turnId,
          ...(row.status === "pending" ? { jobId } : {}),
        });
      }
      if (streamId && !sender) {
        await ctx.db.patch("streamingMessages", streamId, { turnId, jobId });
      }
      return { jobId };
    },
  };
}

/** A pending reply its own job begins again: the turn's open row, adopted. */
export async function adoptOpenRow(
  ctx: MutationCtx,
  adopt: NonNullable<SaveTurn["adopt"]>,
  openStream?: (stamp: Stamp, row: Row) => Promise<Id<"streamingMessages">>,
) {
  const { row, turn, caller } = adopt;
  let streamId: Id<"streamingMessages"> | undefined;
  if (openStream) {
    streamId = await openStream(
      { turnId: turn._id, jobId: caller, at: atOf(turn) },
      row,
    );
    await ctx.db.patch("messages", row._id, { streamId });
    await settle(ctx, turn, { byApp: false });
  }
  return { row, streamId, turn: await turnInfo(ctx, turn, caller) };
}

/** A stream a generation opens at a prompt without saving a message. */
export async function planStream(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  promptMessageId: Id<"messages">,
): Promise<Stamp & { order: number; stepOrder: number }> {
  const prompt = await resolve(ctx, threadId, promptMessageId);
  if (!prompt) throw new Error(`Prompt message ${promptMessageId} not found`);
  // A stream at a prompt sits at the prompt, whatever context its caller read.
  const position = { order: prompt.order, stepOrder: prompt.stepOrder };
  const caller = await callerJob(ctx);
  if (!caller && !prompt.turnId) return position;
  const prompted = await turnsPromptedBy(ctx, prompt);
  const promptTurn = prompted.at(-1) ?? (await turnOf(ctx, prompt));
  const role = await roleOf(ctx, caller, promptTurn);
  if (role.kind === "revoked" || role.kind === "stopped") {
    throw new Error(REFUSED);
  }
  await takeOver(ctx, prompted, role);
  if (role.kind !== "holder") return position;
  return {
    ...position,
    turnId: role.turn._id,
    jobId: caller!,
    at: atOf(role.turn),
  };
}

/** A durable stream's end: its own job's failure, or the app's stop. */
export async function endStream(
  ctx: MutationCtx,
  how: "fail" | "abort",
  stream: Stream,
  args: {
    reason: string;
    finalDelta?: Omit<Doc<"streamDeltas">, "_id" | "_creationTime">;
  },
) {
  if (await closeStoppedStream(ctx, stream)) return true;
  if (stream.state.kind !== "streaming") return false;
  const caller = await callerJob(ctx);
  const holds = caller !== null && caller === stream.jobId;
  // fail is the streamer's own failure; abort, or the app's fail, is a stop.
  if (holds && how === "fail") {
    await abortById(ctx, stream, args);
    await settle(ctx, stream.turnId!, {
      byApp: false,
      wroteFailed: true,
      reason: args.reason,
    });
    return true;
  }
  const turn = await turnOf(ctx, stream);
  if (live(turn)) {
    await handOff(ctx, turn, {
      end: "stopped",
      byOwnJob: false,
      reason: args.reason,
    });
    return true;
  }
  return abortById(ctx, stream, args);
}

/** After a durable stream finishes, its turn may be answered. */
export async function settleStream(ctx: MutationCtx, stream: Stream) {
  if (stream.turnId) await settle(ctx, stream.turnId, { byApp: false });
}

/** A stopped job's own close of its stopped stream ends that stream's rows. */
export async function closeStoppedStream(ctx: MutationCtx, stream: Stream) {
  if (stream.jobId === undefined || stream.state.kind === "streaming") {
    return false;
  }
  const caller = await callerJob(ctx);
  if (caller !== stream.jobId) return false;
  if (stream.state.kind === "aborted" && stream.state.timeoutFnId) {
    await timeoutStoppedStream(ctx, stream);
    return true;
  }
  const role = await roleOf(ctx, caller);
  return role.kind === "stopped" && role.turn._id === stream.turnId;
}

/** A stopped stream's timeout: its runner is gone, so its rows end here. */
export async function timeoutStoppedStream(ctx: MutationCtx, stream: Stream) {
  const left = await ctx.db
    .query("leftOpen")
    .withIndex("streamId", (q) => q.eq("streamId", stream._id))
    .collect();
  for (const { messageId } of left) {
    await endStopped(ctx, (await ctx.db.get("messages", messageId))!);
  }
  await endStoppedStream(ctx, stream._id);
}

export async function timeoutTurnStream(ctx: MutationCtx, stream: Stream) {
  const turn = await turnOf(ctx, stream);
  if (!live(turn) || turn.jobId !== stream.jobId) return false;
  await handOff(ctx, turn, { idle: true });
  return true;
}

/** Ends every live turn whose prompt, resume point, request or open row was deleted. */
export async function endTurnsForDeleted(
  ctx: MutationCtx,
  deleted: (Row | null)[],
) {
  const ended = new Set<string>();
  const end = async (turn: Turn) => {
    if (ended.has(turn._id)) return;
    ended.add(turn._id);
    await handOff(ctx, turn, { end: "deleted", byOwnJob: false });
  };
  for (const row of deleted) {
    if (!row?.turnId) continue;
    const own = await turnOf(ctx, row);
    if (
      live(own) &&
      (row._id === own.requestMessageId || row.status === "pending")
    ) {
      await end(own);
    }
    for (const turn of await turnsPromptedBy(ctx, row)) await end(turn);
  }
}

export async function stopTurns(
  ctx: MutationCtx,
  args: {
    threadId: Id<"threads">;
    order?: number;
    promptMessageId?: Id<"messages">;
  },
  reason = REASONS.stopped,
) {
  let turns: Turn[];
  let order = args.order;
  if (args.promptMessageId) {
    const prompt = await resolve(ctx, args.threadId, args.promptMessageId);
    if (!prompt) return false;
    const prompted = await turnsPromptedBy(ctx, prompt);
    const own = prompted.length > 0 ? null : await turnOf(ctx, prompt);
    turns = live(own) ? [own] : prompted;
    // A plain prompt's inline generation replies at the prompt's order.
    order = turns[0]?.order ?? prompt.order;
  } else {
    turns = await turnsOf(ctx, args.threadId, args.order);
  }
  // First, so this stop's own marked rows are left to their jobs.
  const { stopped, owners } = await stopPlain(
    ctx,
    args.threadId,
    order,
    reason,
  );
  const stopping = new Map(turns.map((turn) => [turn._id, turn]));
  // A turn whose job streams here from another thread stops too, as an abort
  // of that stream by id stops it.
  for (const turnId of owners) {
    if (stopping.has(turnId)) continue;
    const owner = await ctx.db.get("turns", turnId);
    if (live(owner)) stopping.set(turnId, owner);
  }
  for (const turn of stopping.values()) {
    await handOff(ctx, turn, { end: "stopped", byOwnJob: false, reason });
  }
  return stopping.size > 0 || stopped;
}

/**
 * A stop also aborts inline generations' streams, which stops them as on main,
 * and returns the turns whose jobs hold the others.
 */
async function stopPlain(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  order: number | undefined,
  reason: string,
) {
  let stopped = false;
  const owners = new Set<Id<"turns">>();
  await endStoppedInThread(ctx, threadId, order);
  const streams = await ctx.db
    .query("streamingMessages")
    .withIndex("threadId_state_order_stepOrder", (q) => {
      const base = q.eq("threadId", threadId).eq("state.kind", "streaming");
      return order === undefined ? base : base.eq("order", order);
    })
    .collect();
  for (const stream of streams) {
    if (stream.jobId !== undefined) {
      if (stream.turnId) owners.add(stream.turnId);
      continue;
    }
    await abortById(ctx, stream, { reason });
    stopped = true;
  }
  return { stopped, owners };
}

export async function retryTurn(
  ctx: MutationCtx,
  args: {
    threadId: Id<"threads">;
    promptMessageId?: Id<"messages">;
    maxRetries?: number;
  },
): Promise<string | null> {
  let turn: Turn | null;
  if (args.promptMessageId) {
    const prompt = await resolve(ctx, args.threadId, args.promptMessageId);
    turn = prompt && (await turnFor(ctx, prompt));
  } else {
    turn = await newestTurn(ctx, args.threadId);
  }
  if (turn?.outcome === "stopped") await endStoppedMembers(ctx, turn);
  if (!turn || turn.status !== "running") return null;
  if (turn.jobId) {
    const state = await jobState(ctx, turn);
    if (state === "pending" || state === "inProgress") return turn.jobId;
    if (state === "success") {
      await handOff(ctx, turn, { end: "unanswered", byOwnJob: false });
      return null;
    }
  }
  if (turn.retries >= (args.maxRetries ?? DEFAULT_MAX_RETRIES)) {
    await handOff(ctx, turn, { end: "exhausted", byOwnJob: false });
    return null;
  }
  const jobId = await schedule(ctx, turn, turn.anchorMessageId);
  await handOff(ctx, turn, { job: jobId, newRow: true });
  return jobId;
}

/** How an approval or tool output answers the turn its request belongs to. */
export async function planResponse(
  ctx: MutationCtx,
  request: Row,
  generate: string | undefined,
): Promise<SaveTurn | undefined> {
  const turn = await turnOf(ctx, request);
  const caller = await callerJob(ctx);
  const role = await roleOf(ctx, caller, turn);
  if (role.kind === "revoked" || role.kind === "stopped") {
    throw new Error(REFUSED);
  }
  if (!live(turn)) {
    // A request of an ended turn takes its answer, but nothing continues it.
    return generate === undefined || turn
      ? undefined
      : planSend(
          ctx,
          { threadId: request.threadId, generate, order: request.order },
          caller,
        );
  }
  if (role.kind === "holder" && role.turn._id !== turn._id) {
    throw new Error(REFUSED);
  }
  const byApp = role.kind !== "holder";
  return {
    stamp: (order) => (order === turn.order ? { turnId: turn._id } : {}),
    after: async (saved) => {
      const jobId = await settle(ctx, turn._id, {
        byApp,
        continueWith:
          generate === undefined ? undefined : { generate, anchor: saved[0] },
      });
      return jobId ? { jobId } : {};
    },
  };
}
