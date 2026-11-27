import type { FunctionHandle } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { finalizePending, getMaxMessage } from "./messages.js";
import { abortById, finishHandler } from "./streams.js";

type Turn = Doc<"turns">;
type Row = Doc<"messages">;
type Stream = Doc<"streamingMessages">;
type Status = Row["status"];
type Role =
  | { kind: "app" }
  | { kind: "holder"; turn: Turn }
  | { kind: "revoked" };
export type Stamp = { turnId?: Id<"turns">; jobId?: string };
export type TurnInfo = { promptMessageId: Id<"messages">; jobId: string };

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
  if (hint && hint.jobId === caller) {
    return live(hint) ? { kind: "holder", turn: hint } : { kind: "app" };
  }
  const job = await ctx.db
    .query("jobs")
    .withIndex("jobId", (q) => q.eq("jobId", caller))
    .first();
  if (!job) return { kind: "app" };
  const turn = await ctx.db.get("turns", job.turnId);
  if (!turn || turn.jobId !== caller) return { kind: "revoked" };
  return live(turn) ? { kind: "holder", turn } : { kind: "app" };
}

type Write =
  | { as: "turn"; turn: Turn; caller: string }
  | { as: "app"; liveTurn?: Turn };

/** Who may write an existing row: its turn's job, the app, or no one. */
export async function authorizeRow(ctx: MutationCtx, row: Row): Promise<Write> {
  if (!row.turnId) return { as: "app" };
  const caller = await callerJob(ctx);
  const turn = await turnOf(ctx, row);
  const role = await roleOf(ctx, caller, turn);
  if (role.kind === "revoked") throw new Error(REFUSED);
  if (!live(turn)) return { as: "app" };
  if (role.kind === "holder" && role.turn._id === turn._id) {
    return { as: "turn", turn, caller: caller! };
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

// members: the only enumerator of a turn's rows and streams.
function members(
  ctx: MutationCtx,
  turn: Turn,
  status: Status,
  since?: "anchor",
) {
  return ctx.db
    .query("messages")
    .withIndex("turnId_status_order_stepOrder", (q) => {
      const base = q.eq("turnId", turn._id).eq("status", status);
      return since
        ? base.eq("order", turn.order).gt("stepOrder", turn.anchorStepOrder)
        : base;
    })
    .collect();
}

function memberStreams(
  ctx: MutationCtx,
  turn: Turn,
  kind: Stream["state"]["kind"],
) {
  return ctx.db
    .query("streamingMessages")
    .withIndex("turnId_state_order", (q) =>
      q.eq("turnId", turn._id).eq("state.kind", kind),
    )
    .collect();
}

async function settledMembers(ctx: MutationCtx, turn: Turn, since?: "anchor") {
  return [
    ...(await members(ctx, turn, "success", since)),
    ...(await members(ctx, turn, "failed", since)),
  ]
    .filter(at(turn))
    .sort((a, b) => a.stepOrder - b.stepOrder);
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
): Promise<Detected> {
  if (wroteFailed) return { kind: "failed" };
  const atOrder = at(turn);
  if ((await members(ctx, turn, "pending")).some(atOrder)) {
    return { kind: "open" };
  }
  if ((await memberStreams(ctx, turn, "streaming")).some(atOrder)) {
    return { kind: "open" };
  }
  const rows = await settledMembers(ctx, turn, "anchor");
  if (!rows.length) {
    const finished = (await memberStreams(ctx, turn, "finished")).some(
      (s) => atOrder(s) && s.jobId === turn.jobId,
    );
    return { kind: finished ? "answered" : "none" };
  }
  if (rows.at(-1)!.status === "failed") return { kind: "failed" };
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

async function closeRow(
  ctx: MutationCtx,
  row: Row,
  result: { status: "success" } | { status: "failed"; error: string },
) {
  await finalizePending(
    ctx,
    row,
    result,
    undefined,
    row.streamId ? [row.streamId] : [],
  );
  await ctx.db.patch("messages", row._id, { jobId: undefined });
}

async function closeStream(
  ctx: MutationCtx,
  stream: Stream,
  finished: boolean,
  reason: string,
) {
  const fresh = await ctx.db.get("streamingMessages", stream._id);
  if (fresh?.state.kind !== "streaming") return;
  if (finished) await finishHandler(ctx, { streamId: stream._id });
  else await abortById(ctx, { streamId: stream._id, reason });
}

// handOff: the only writer of a turn's job and status, and of a row's job copy.
async function handOff(ctx: MutationCtx, turn: Turn, to: To) {
  const openRows = await members(ctx, turn, "pending");
  const openStreams = await memberStreams(ctx, turn, "streaming");
  const atOrder = at(turn);
  if ("waiting" in to) {
    await ctx.db.patch("turns", turn._id, {
      status: "waiting",
      requestMessageId: to.waiting,
    });
    return;
  }
  if ("idle" in to) {
    for (const s of openStreams) await closeStream(ctx, s, false, TIMED_OUT);
    for (const row of openRows.filter(atOrder)) {
      await closeRow(ctx, row, { status: "failed", error: TIMED_OUT });
    }
    await ctx.db.patch("turns", turn._id, { jobId: undefined });
    return;
  }
  await cancelQueued(ctx, turn);
  if ("job" in to) {
    for (const s of openStreams) await closeStream(ctx, s, false, "Retried");
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
    if (!atOrder(row) && byOwnJob) {
      await ctx.db.patch("messages", row._id, { jobId: undefined });
    } else if (end === "answered") {
      await ctx.db.patch("messages", row._id, {
        status: "success",
        jobId: undefined,
      });
    } else if (end === "stopped") {
      await closeRow(ctx, row, { status: "success" });
      await ctx.db.patch("messages", row._id, {
        jobId: undefined,
        abort: { reason },
      });
    } else {
      await closeRow(ctx, row, { status: "failed", error: reason });
    }
  }
  for (const s of openStreams) {
    await closeStream(ctx, s, end === "answered", reason);
  }
  if (end === "stopped" && !openRows.some(atOrder)) {
    const newest = (await settledMembers(ctx, turn)).at(-1);
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
    jobId: byOwnJob ? turn.jobId : undefined,
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

async function jobRunning(ctx: MutationCtx, turn: Turn) {
  const state = await jobState(ctx, turn);
  return state === "pending" || state === "inProgress";
}

async function cancelQueued(ctx: MutationCtx, turn: Turn) {
  if (!turn.jobId) return;
  const job = await ctx.db.system.get(
    "_scheduled_functions",
    turn.jobId as Id<"_scheduled_functions">,
  );
  if (job?.state.kind === "pending") await ctx.scheduler.cancel(job._id);
}

// schedule: the only scheduler of a turn's jobs.
async function schedule(
  ctx: MutationCtx,
  turn: Pick<Turn, "_id" | "threadId" | "generate">,
  anchor: Id<"messages">,
) {
  const jobId: string = await ctx.scheduler.runAfter(
    0,
    turn.generate as FunctionHandle<"action">,
    { threadId: turn.threadId, promptMessageId: anchor },
  );
  await ctx.db.insert("jobs", { jobId, turnId: turn._id });
  return jobId;
}

type Settle = {
  byApp: boolean;
  wroteFailed?: boolean;
  reason?: string;
  continueWith?: { generate: string; anchor: Row };
};

/** The epilogue of every mutation that writes a live turn's member. */
export async function settle(
  ctx: MutationCtx,
  turnId: Id<"turns">,
  w: Settle,
): Promise<string | undefined> {
  const turn = await ctx.db.get("turns", turnId);
  if (!live(turn)) return;
  const result = await detect(ctx, turn, !!w.wroteFailed);
  if (result.kind === "open" || result.kind === "none") {
    if (turn.status === "waiting") {
      await ctx.db.patch("turns", turn._id, {
        status: "running",
        requestMessageId: undefined,
      });
    }
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

async function liveTurns(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  order?: number,
) {
  const lists = await Promise.all(
    (["running", "waiting"] as const).map((status) =>
      ctx.db
        .query("turns")
        .withIndex("threadId_status_order", (q) => {
          const base = q.eq("threadId", threadId).eq("status", status);
          return order === undefined ? base : base.eq("order", order);
        })
        .collect(),
    ),
  );
  return lists.flat();
}

async function newestTurn(ctx: MutationCtx, threadId: Id<"threads">) {
  const newest = await Promise.all(
    (["running", "waiting", "done"] as const).map((status) =>
      ctx.db
        .query("turns")
        .withIndex("threadId_status_order", (q) =>
          q.eq("threadId", threadId).eq("status", status),
        )
        .order("desc")
        .first(),
    ),
  );
  return (
    newest
      .filter((t) => t !== null)
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
  for (const turn of await liveTurns(ctx, threadId)) {
    if (caller && turn.jobId === caller) continue;
    // A running turn elsewhere keeps its live job; a dead one is replaced.
    const replaced =
      turn.status === "running"
        ? turn.order === order || !(await jobRunning(ctx, turn))
        : order === undefined || turn.order <= order;
    if (replaced) {
      await handOff(ctx, turn, { end: "superseded", byOwnJob: false });
    }
  }
}

async function takeOver(ctx: MutationCtx, prompt: Row, role: Role) {
  const turn = await turnOf(ctx, prompt);
  if (!live(turn) || !anchors(turn, prompt)) return;
  if (role.kind === "holder" && role.turn._id === turn._id) return;
  await handOff(ctx, turn, { end: "takenOver", byOwnJob: false });
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
  adopt?: { row: Row; turn: Turn; caller: string };
  after?: (
    saved: Row[],
    streamId?: Id<"streamingMessages">,
  ) => Promise<{ jobId?: string; turn?: TurnInfo }>;
};

const turnInfo = (turn: Turn, jobId: string): TurnInfo => ({
  promptMessageId: turn.promptMessageId,
  jobId,
});

/** A holder's rows at its turn are members; elsewhere only its open rows are leased. */
function memberStamp(turn: Turn, caller: string, threadId: Id<"threads">) {
  return (order: number, status: Status, replaced?: Row): Stamp => {
    const job = status === "pending" ? { jobId: caller } : {};
    if (replaced) return { turnId: replaced.turnId, ...job };
    if (threadId !== turn.threadId || order !== turn.order) {
      return status === "pending" ? { turnId: turn._id, ...job } : {};
    }
    return { turnId: turn._id, ...job };
  };
}

export async function planSave(
  ctx: MutationCtx,
  args: {
    threadId: Id<"threads">;
    generate?: string;
    promptMessage?: Row | null;
    pendingMessageId?: Id<"messages">;
    order?: number | "next";
    messages: { status?: Status }[];
  },
): Promise<SaveTurn> {
  const caller = await callerJob(ctx);
  const pending = args.pendingMessageId
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
    if (!pending.turnId) return { pending };
    const write = await authorizeRow(ctx, pending);
    if (
      write.as === "turn" || write.liveTurn
        ? args.promptMessage && args.promptMessage.order !== pending.order
        : false
    ) {
      throw new Error("A live turn's reply can't move to another prompt");
    }
    return planFill(ctx, pending, write);
  }
  if (!caller && !args.promptMessage?.turnId) return { pending };
  const prompt = args.promptMessage ?? null;
  const role = await roleOf(
    ctx,
    caller,
    prompt ? await turnOf(ctx, prompt) : null,
  );
  if (role.kind === "revoked") throw new Error(REFUSED);
  if (prompt && beginning) await takeOver(ctx, prompt, role);
  if (role.kind !== "holder") return { pending };
  const turn = role.turn;
  const own = caller!;
  const atTurn =
    turn.threadId === args.threadId &&
    (prompt ? prompt.order === turn.order : args.order === turn.order);
  if (!atTurn) return { pending, ...lease(turn, own) };
  const userId = await promptUser(ctx, turn);
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
    streamStamp: { turnId: turn._id, jobId: own },
    after: async () => {
      await settle(ctx, turn._id, { byApp: false });
      return beginning ? { turn: turnInfo(turn, own) } : {};
    },
  };
}

/** Whatever a job opens away from its turn is still its own, so ending its turn closes it. */
function lease(turn: Turn, caller: string): SaveTurn {
  const stamp = { turnId: turn._id, jobId: caller };
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
  if (role.kind === "revoked") throw new Error(REFUSED);
  return role.kind === "holder" ? { turnId: role.turn._id, jobId: caller } : {};
}

function planFill(ctx: MutationCtx, pending: Row, write: Write): SaveTurn {
  const turnId = write.as === "turn" ? write.turn._id : write.liveTurn?._id;
  return {
    pending,
    userId: turnId ? pending.userId : undefined,
    carry: turnId ? pending.streamId : undefined,
    stamp:
      write.as === "turn"
        ? memberStamp(write.turn, write.caller, pending.threadId)
        : (_order, _status, replaced) =>
            replaced ? { turnId: replaced.turnId } : {},
    streamStamp:
      write.as === "turn"
        ? { turnId: write.turn._id, jobId: write.caller }
        : undefined,
    after: async (saved) => {
      const row = saved.find((doc) => doc._id === pending._id);
      const carried = saved.some(
        (doc) => doc._id !== pending._id && doc.streamId === pending.streamId,
      );
      if (pending.streamId && row && row.status !== "pending" && !carried) {
        const stream = await ctx.db.get("streamingMessages", pending.streamId);
        if (stream) {
          await closeStream(ctx, stream, row.status === "success", "Filled");
        }
      }
      if (turnId) {
        await settle(ctx, turnId, {
          byApp: write.as === "app",
          wroteFailed: saved.some((doc) => doc.status === "failed"),
        });
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
  if (role.kind === "revoked") throw new Error(REFUSED);
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
      const turnId = await ctx.db.insert("turns", {
        threadId: args.threadId,
        order: prompt.order,
        promptMessageId: prompt._id,
        anchorMessageId: prompt._id,
        // A pending anchor is the reply itself, so it counts as a member.
        anchorStepOrder:
          prompt.status === "pending" ? prompt.stepOrder - 1 : prompt.stepOrder,
        generate: args.generate,
        retries: 0,
        status: "running",
      });
      const jobId = await schedule(
        ctx,
        { _id: turnId, threadId: args.threadId, generate: args.generate },
        prompt._id,
      );
      await ctx.db.patch("turns", turnId, { jobId });
      // Stamped in the save's own transaction: the turn needs the rows' ids.
      const stamped = args.promptMessage
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
    streamId = await openStream({ turnId: turn._id, jobId: caller }, row);
    await ctx.db.patch("messages", row._id, { streamId });
  }
  return { row, streamId, turn: turnInfo(turn, caller) };
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
  const role = await roleOf(ctx, caller, await turnOf(ctx, prompt));
  if (role.kind === "revoked") throw new Error(REFUSED);
  await takeOver(ctx, prompt, role);
  if (role.kind !== "holder") return position;
  return { ...position, turnId: role.turn._id, jobId: caller! };
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
  const caller = await callerJob(ctx);
  if (caller === stream.jobId) {
    if (stream.state.kind !== "streaming") return false;
    await abortById(ctx, { streamId: stream._id, ...args });
    // Its job failing its stream fails the turn; aborting one only ends it.
    await settle(ctx, stream.turnId!, {
      byApp: false,
      wroteFailed: how === "fail",
      reason: args.reason,
    });
    return true;
  }
  const role = await roleOf(ctx, caller);
  if (role.kind !== "app") return false;
  const turn = await turnOf(ctx, stream);
  if (live(turn)) {
    await handOff(ctx, turn, {
      end: "stopped",
      byOwnJob: false,
      reason: args.reason,
    });
    return true;
  }
  if (stream.state.kind !== "streaming") return false;
  return abortById(ctx, { streamId: stream._id, ...args });
}

/** After a durable stream finishes, its turn may be answered. */
export async function settleStream(ctx: MutationCtx, stream: Stream) {
  if (stream.turnId) await settle(ctx, stream.turnId, { byApp: false });
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
  for (const row of deleted) {
    if (!row?.turnId || ended.has(row.turnId)) continue;
    const turn = await ctx.db.get("turns", row.turnId);
    if (!live(turn)) continue;
    const vital =
      anchors(turn, row) ||
      row._id === turn.requestMessageId ||
      row.status === "pending";
    if (!vital) continue;
    ended.add(turn._id);
    await handOff(ctx, turn, { end: "deleted", byOwnJob: false });
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
  if (args.promptMessageId) {
    const prompt = await resolve(ctx, args.threadId, args.promptMessageId);
    const turn = prompt && (await turnOf(ctx, prompt));
    turns = live(turn) ? [turn] : [];
  } else {
    turns = await liveTurns(ctx, args.threadId, args.order);
  }
  for (const turn of turns) {
    await handOff(ctx, turn, { end: "stopped", byOwnJob: false, reason });
  }
  const order = args.promptMessageId ? turns[0]?.order : args.order;
  if (args.promptMessageId && order === undefined) return false;
  const plain = await stopPlain(ctx, args.threadId, order, reason);
  return turns.length > 0 || plain;
}

/** A stop also reaches inline generations: their pending replies and streams. */
async function stopPlain(
  ctx: MutationCtx,
  threadId: Id<"threads">,
  order: number | undefined,
  reason: string,
) {
  let stopped = false;
  for (const tool of [false, true]) {
    const rows = await ctx.db
      .query("messages")
      .withIndex("threadId_status_tool_order_stepOrder", (q) => {
        const base = q
          .eq("threadId", threadId)
          .eq("status", "pending")
          .eq("tool", tool);
        return order === undefined ? base : base.eq("order", order);
      })
      .collect();
    for (const row of rows) {
      if (row.jobId !== undefined) continue;
      await ctx.db.patch("messages", row._id, { abort: { reason } });
      stopped = true;
    }
  }
  const streams = await ctx.db
    .query("streamingMessages")
    .withIndex("threadId_state_order_stepOrder", (q) => {
      const base = q.eq("threadId", threadId).eq("state.kind", "streaming");
      return order === undefined ? base : base.eq("order", order);
    })
    .collect();
  for (const stream of streams) {
    if (stream.jobId !== undefined) continue;
    await abortById(ctx, { streamId: stream._id, reason });
    stopped = true;
  }
  return stopped;
}

/** An app's stop of a plain stream reaches the pending reply it streams into. */
export async function stopStreamReply(
  ctx: MutationCtx,
  stream: Stream,
  reason: string,
) {
  for (const tool of [false, true]) {
    const rows = await ctx.db
      .query("messages")
      .withIndex("threadId_status_tool_order_stepOrder", (q) =>
        q
          .eq("threadId", stream.threadId)
          .eq("status", "pending")
          .eq("tool", tool)
          .eq("order", stream.order)
          .eq("stepOrder", stream.stepOrder),
      )
      .collect();
    for (const row of rows) {
      if (row.jobId === undefined) {
        await ctx.db.patch("messages", row._id, { abort: { reason } });
      }
    }
  }
}

/** Deleting a plain prompt fails the plain replies pending at its order. */
export async function failPlainReplies(ctx: MutationCtx, deleted: Row[]) {
  const seen = new Set<string>();
  for (const row of deleted) {
    const key = `${row.threadId}:${row.order}`;
    if (row.status === "pending" || seen.has(key)) continue;
    seen.add(key);
    for (const tool of [false, true]) {
      const rows = await ctx.db
        .query("messages")
        .withIndex("threadId_status_tool_order_stepOrder", (q) =>
          q
            .eq("threadId", row.threadId)
            .eq("status", "pending")
            .eq("tool", tool)
            .eq("order", row.order),
        )
        .collect();
      for (const reply of rows) {
        if (reply.jobId !== undefined) continue;
        await finalizePending(
          ctx,
          reply,
          { status: "failed", error: REASONS.deleted },
          undefined,
        );
      }
    }
  }
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
    turn = prompt && (await turnOf(ctx, prompt));
  } else {
    turn = await newestTurn(ctx, args.threadId);
  }
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
  if (role.kind === "revoked") throw new Error(REFUSED);
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
