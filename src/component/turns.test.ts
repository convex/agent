import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { v } from "convex/values";
import {
  createFunctionHandle,
  defineSchema,
  makeFunctionReference,
} from "convex/server";
import { defineTestApp } from "convex-test";
import componentTest from "../test.js";

const app = defineTestApp({
  schema: defineSchema({}),
  components: { agent: componentTest },
});
const api = app.components.agent;
type Ids = { threadId: string; promptMessageId: string };
type Ctx = {
  runMutation: (ref: any, args: any) => Promise<any>;
};
type Attempt = (ctx: Ctx, ids: Ids) => Promise<unknown>;
type Metered = {
  getTransactionMetrics: () => Promise<{
    documentsRead: { used: number };
    documentsWritten: { used: number };
  }>;
};

const generate = makeFunctionReference<"action", Ids>("turns:generate");
const attempts: Attempt[] = [];
let jobs = 0;
beforeEach(() => {
  attempts.length = 0;
  jobs = 0;
});
afterEach(() => vi.useRealTimers());

const { createTest } = app.defineModules({
  turns: {
    generate: app.action({
      args: { threadId: v.string(), promptMessageId: v.string() },
      handler: async (ctx, ids) => {
        jobs++;
        const attempt = attempts.shift();
        if (attempt) await attempt(ctx as never, ids);
      },
    }),
  },
});

const pending = {
  message: { role: "assistant", content: [] },
  status: "pending",
};
const assistant = (content: unknown) => ({
  message: { role: "assistant", content },
});
const call = (id: string) => ({
  type: "tool-call",
  toolCallId: id,
  toolName: "lookup",
  input: {},
});
const result = (id: string) => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "lookup",
      output: { type: "text", value: `result ${id}` },
    },
  ],
});
const tried = <R>(p: Promise<R>) =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (e: Error) => ({ ok: false as const, error: e.message }),
  );
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};

/** What a generation's job does first: a pending reply with its stream. */
const begin = (ctx: Ctx, ids: Ids) =>
  ctx.runMutation(api.messages.addMessages, {
    ...ids,
    messages: [pending],
    createStream: { format: "UIMessageChunk" },
  }) as Promise<{
    messages: { _id: string }[];
    streamId?: string;
    turn?: {
      promptMessageId: string;
      jobId: string;
      saved: { message?: { role: string }; tool: boolean; text?: string }[];
    };
  }>;
const delta = (ctx: Ctx, streamId: string, text: string, start = 0) =>
  ctx.runMutation(api.streams.addDelta, {
    streamId,
    start,
    end: start + 1,
    parts: [
      ...(start === 0 ? [{ type: "text-start", id: "t" }] : []),
      { type: "text-delta", id: "t", delta: text },
    ],
  }) as Promise<boolean>;
const fill = (
  ctx: Ctx,
  threadId: string,
  pendingMessageId: string,
  messages: unknown[],
  createStream = false,
) =>
  ctx.runMutation(api.messages.addMessages, {
    threadId,
    pendingMessageId,
    messages,
    ...(createStream ? { createStream: { format: "UIMessageChunk" } } : {}),
  }) as Promise<{ messages: { _id: string }[]; streamId?: string }>;

async function submitted() {
  const t = createTest();
  const handle = await t.mutation(() => createFunctionHandle(generate));
  const { threadId, promptMessageId, jobId } = await t.mutation(async (ctx) => {
    const thread = await ctx.runMutation(api.threads.createThread, {});
    const sent = await ctx.runMutation(api.messages.addMessages, {
      threadId: thread._id,
      messages: [{ message: { role: "user", content: "Go." } }],
      generate: handle,
    });
    return {
      threadId: thread._id,
      promptMessageId: sent.messages[0]._id,
      jobId: sent.jobId!,
    };
  });
  const docs = async () =>
    (
      await t.query((ctx) =>
        ctx.runQuery(api.messages.listMessagesByThreadId, {
          threadId,
          order: "asc",
          statuses: ["pending", "success", "failed"],
          paginationOpts: { numItems: 100, cursor: null },
        }),
      )
    ).page;
  const rows = async () =>
    (await docs()).map((m) => [m.message?.role, m.status, m.text]);
  const streams = () =>
    t.query((ctx) =>
      ctx.runQuery(api.streams.list, {
        threadId,
        statuses: ["streaming", "finished", "aborted"],
      }),
    );
  const control = <R>(fn: (ctx: Ctx) => Promise<R>) =>
    t.mutation((ctx) => fn(ctx as never));
  return {
    t,
    handle,
    ids: { threadId, promptMessageId },
    jobId,
    docs,
    rows,
    streams,
    retry: () =>
      control((ctx) =>
        ctx.runMutation(api.messages.retryGeneration, { threadId }),
      ),
    stop: () =>
      control((ctx) =>
        ctx.runMutation(api.messages.abortGeneration, { threadId }),
      ),
    drain: () => t.finishAllScheduledFunctions(() => {}),
    control,
  };
}

test("a send's job owns its turn: its writes land, the app's writes into its stream are refused, and its answer ends the turn", async () => {
  const seen: Record<string, unknown> = {};
  let streamId!: string;
  const answer = gate();
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    streamId = own.streamId!;
    seen.turn = own.turn;
    seen.own = await delta(ctx, streamId, "Hello");
    await answer.opened;
    await fill(ctx, ids.threadId, own.messages[0]._id, [assistant("Hello.")]);
  });
  const s = await submitted();
  const job = s.drain();
  while (!seen.own) await new Promise((r) => setTimeout(r, 2));
  seen.app = await s.control((ctx) => delta(ctx, streamId, "Not mine", 1));
  answer.open();
  await job;
  expect({
    turn: seen.turn,
    own: seen.own,
    app: seen.app,
    rows: await s.rows(),
    streams: (await s.streams()).map((x) => x.status),
    retry: await s.retry(),
    stop: await s.stop(),
  }).toEqual({
    turn: { promptMessageId: s.ids.promptMessageId, jobId: s.jobId, saved: [] },
    own: true,
    app: false,
    rows: [
      ["user", "success", "Go."],
      ["assistant", "success", "Hello."],
    ],
    streams: ["finished"],
    retry: null,
    stop: false,
  });
});

test("a stop ends the turn: every stream the job holds closes, the job's next save into its reply is that reply's ending, and the job is refused after", async () => {
  const stopped = gate();
  const seen: Record<string, unknown> = {};
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    await delta(ctx, own.streamId!, "Half.");
    const away = await ctx.runMutation(api.threads.createThread, {});
    seen.away = await ctx.runMutation(api.streams.create, {
      threadId: away._id,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk",
    });
    seen.ready = true;
    await stopped.opened;
    seen.late = await delta(ctx, own.streamId!, " More.", 1);
    seen.lateFill = (
      await tried(
        fill(ctx, ids.threadId, own.messages[0]._id, [
          assistant("Late."),
          pending,
        ]),
      )
    ).ok;
    seen.after = await tried(begin(ctx, ids));
  });
  const s = await submitted();
  const job = s.drain();
  while (!seen.ready) await new Promise((r) => setTimeout(r, 2));
  const stop = await s.stop();
  stopped.open();
  await job;
  const [, reply] = await s.docs();
  expect({
    stop,
    reply: [reply.status, reply.text, reply.error],
    streams: (await s.streams()).map((x) => x.status),
    late: seen.late,
    lateFill: seen.lateFill,
    after: seen.after,
    rows: (await s.docs()).length,
    retry: await s.retry(),
  }).toEqual({
    stop: true,
    reply: ["failed", "Late.", "Stopped"],
    streams: ["aborted"],
    late: false,
    lateFill: true,
    after: {
      ok: false,
      error: expect.stringContaining("stopped or replaced"),
    },
    rows: 2,
    retry: null,
  });
});

test("a retry after a crash past a saved step resumes in the same reply row, and the crashed job's writes are refused", async () => {
  const release = gate();
  const seen: Record<string, unknown> = {};
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    const next = await fill(
      ctx,
      ids.threadId,
      own.messages[0]._id,
      [assistant([call("c1")]), { message: result("c1") }, pending],
      true,
    );
    seen.openRow = next.messages.at(-1)!._id;
    await delta(ctx, next.streamId!, "Half.");
    void release.opened.then(async () => {
      seen.straggler = await tried(
        fill(ctx, ids.threadId, next.messages.at(-1)!._id, [
          assistant("Stale."),
        ]),
      );
    });
    throw new Error("crashed");
  });
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    seen.adopted = own.messages[0]._id;
    await fill(ctx, ids.threadId, own.messages[0]._id, [assistant("Done.")]);
  });
  const s = await submitted();
  await s.drain();
  const retried = await s.retry();
  await s.drain();
  release.open();
  while (!seen.straggler) await new Promise((r) => setTimeout(r, 2));
  expect({
    retried: typeof retried,
    adopted: seen.adopted === seen.openRow,
    straggler: (seen.straggler as { ok: boolean }).ok,
    rows: await s.rows(),
    jobs,
    again: await s.retry(),
  }).toEqual({
    retried: "string",
    adopted: true,
    straggler: false,
    rows: [
      ["user", "success", "Go."],
      ["assistant", "success", undefined],
      ["tool", "success", undefined],
      ["assistant", "success", "Done."],
    ],
    jobs: 2,
    again: null,
  });
});

test("a retry after a stream timeout writes a new reply row; the timed-out row is gone, never reopened", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let crashed = false;
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    await delta(ctx, own.streamId!, "Half.");
    crashed = true;
    throw new Error("crashed");
  });
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    await fill(ctx, ids.threadId, own.messages[0]._id, [assistant("Done.")]);
  });
  const s = await submitted();
  await s.t.finishInProgressScheduledFunctions();
  while (!crashed) await vi.advanceTimersByTimeAsync(1);
  await s.t.finishInProgressScheduledFunctions();
  vi.advanceTimersByTime(11 * 60 * 1000);
  await s.t.finishInProgressScheduledFunctions();
  const timedOut = await s.docs();
  expect(await s.retry()).not.toBeNull();
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
  const after = await s.docs();
  expect({
    timedOut: timedOut.map((m) => [m.status, m.text]),
    rows: after.map((m) => [m.status, m.text]),
    newRow: after[1]._id !== timedOut[1]._id,
  }).toEqual({
    timedOut: [
      ["success", "Go."],
      ["failed", "Half."],
    ],
    rows: [
      ["success", "Go."],
      ["success", "Done."],
    ],
    newRow: true,
  });
});

test("an approval waits; approving with generate continues the turn, and a stop before the continuation runs keeps it from running", async () => {
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    await fill(ctx, ids.threadId, own.messages[0]._id, [
      assistant([
        call("c1"),
        { type: "tool-approval-request", approvalId: "a1", toolCallId: "c1" },
      ]),
    ]);
  });
  const s = await submitted();
  await s.drain();
  const waiting = await s.retry();
  const approved = await s.control((ctx) =>
    ctx.runMutation(api.messages.respondToToolCallApprovals, {
      threadId: s.ids.threadId,
      decisions: [{ approvalId: "a1", approved: true }],
      generate: s.handle,
    }),
  );
  const stop = await s.stop();
  await s.drain();
  expect({
    waiting,
    continued: typeof approved.jobId,
    stop,
    jobs,
  }).toEqual({
    waiting: null,
    continued: "string",
    stop: true,
    jobs: 1,
  });
});

test("tool call, result and answer saved one by one: the turn is answered at the result, and the job then writes as the app", async () => {
  let followUp!: { ok: boolean };
  attempts.push(async (ctx, ids) => {
    const save = (message: unknown) =>
      ctx.runMutation(api.messages.addMessages, {
        ...ids,
        messages: [{ message }],
      });
    await save({ role: "assistant", content: [call("c")] });
    await save(result("c"));
    await save({ role: "assistant", content: "Answer." });
    followUp = await tried(
      ctx.runMutation(api.messages.addMessages, {
        threadId: ids.threadId,
        order: "next",
        messages: [{ message: { role: "user", content: "Follow-up." } }],
      }),
    );
  });
  const s = await submitted();
  await s.drain();
  expect({
    followUp: followUp.ok,
    stop: await s.stop(),
    retry: await s.retry(),
  }).toEqual({ followUp: true, stop: false, retry: null });
});

test("a job that sends at its own prompt starts a second turn: the sent row is the new job's, the stream it opened is its own", async () => {
  const seen: Record<string, unknown> = {};
  attempts.push(async (ctx, ids) => {
    const sent = await ctx.runMutation(api.messages.addMessages, {
      ...ids,
      messages: [pending],
      createStream: { format: "UIMessageChunk" },
      generate: await createFunctionHandle(generate),
    });
    seen.sentRow = sent.messages[0]._id;
    seen.delta = await delta(ctx, sent.streamId, "Mine.");
    seen.fill = await tried(
      fill(ctx, ids.threadId, sent.messages[0]._id, [assistant("Late.")]),
    );
    seen.finish = await tried(
      ctx.runMutation(api.streams.finish, { streamId: sent.streamId }),
    );
  });
  attempts.push(async () => {
    throw new Error("crashed");
  });
  attempts.push(async (ctx) => {
    const own = await ctx.runMutation(api.messages.addMessages, {
      threadId: (await Promise.resolve(seen.threadId)) as string,
      pendingMessageId: seen.sentRow,
      messages: [assistant("Done.")],
    });
    seen.adopted = own.messages[0]._id === seen.sentRow;
  });
  const s = await submitted();
  seen.threadId = s.ids.threadId;
  await s.drain();
  const retried = await s.control((ctx) =>
    ctx.runMutation(api.messages.retryGeneration, {
      threadId: s.ids.threadId,
      promptMessageId: seen.sentRow,
    }),
  );
  await s.drain();
  const sentRow = (await s.docs()).find((m) => m._id === seen.sentRow)!;
  expect({
    delta: seen.delta,
    finish: (seen.finish as { ok: boolean }).ok,
    fill: seen.fill,
    retried: typeof retried,
    sentRow: [sentRow.status, sentRow.text],
    streaming: (await s.streams()).filter((x) => x.status === "streaming"),
    jobs,
  }).toEqual({
    delta: true,
    finish: true,
    fill: { ok: false, error: expect.stringContaining("stopped or replaced") },
    retried: "string",
    sentRow: ["success", "Done."],
    streaming: [],
    jobs: 3,
  });
});

test("a send at a live turn's order supersedes it, and the old reply's recovered rows stay before the new prompt", async () => {
  const crashed = gate();
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    await ctx.runMutation(api.streams.addDelta, {
      streamId: own.streamId,
      start: 0,
      end: 2,
      parts: [
        { type: "text-start", id: "a" },
        { type: "text-delta", id: "a", delta: "Half." },
      ],
    });
    crashed.open();
  });
  attempts.push(async () => {});
  const s = await submitted();
  await s.drain();
  await crashed.opened;
  await s.control((ctx) =>
    ctx.runMutation(api.messages.addMessages, {
      threadId: s.ids.threadId,
      promptMessageId: s.ids.promptMessageId,
      messages: [{ message: { role: "user", content: "Again." } }],
      generate: s.handle,
    }),
  );
  await s.drain();
  const docs = await s.docs();
  expect({
    rows: await s.rows(),
    last: docs.at(-1)!.text,
    distinct:
      new Set(docs.map((m) => `${m.order}-${m.stepOrder}`)).size ===
      docs.length,
  }).toEqual({
    rows: [
      ["user", "success", "Go."],
      ["assistant", "failed", "Half."],
      ["user", "success", "Again."],
    ],
    last: "Again.",
    distinct: true,
  });
});

test("a generation begun at a live turn's prompt by anyone but its job takes the turn over and runs plain", async () => {
  const seen: Record<string, unknown> = {};
  attempts.push(async (ctx, ids) => {
    await new Promise((r) => setTimeout(r, 0));
    seen.job = await tried(begin(ctx, ids));
  });
  const s = await submitted();
  const takeover = await s.control((ctx) => begin(ctx, s.ids));
  await s.drain();
  expect({
    turn: takeover.turn,
    job: (seen.job as { ok: boolean } | undefined)?.ok ?? "never ran",
    retry: await s.retry(),
  }).toEqual({ turn: undefined, job: "never ran", retry: null });
});

test("deleting an older finished step leaves the turn running; deleting its prompt ends it", async () => {
  const go = gate();
  let saved!: string;
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    const next = await fill(ctx, ids.threadId, own.messages[0]._id, [
      assistant([call("c1")]),
      { message: result("c1") },
      pending,
    ]);
    saved = next.messages[0]._id;
    await go.opened;
  });
  const s = await submitted();
  const job = s.drain();
  while (!saved) await new Promise((r) => setTimeout(r, 2));
  await s.control((ctx) =>
    ctx.runMutation(api.messages.deleteByIds, { messageIds: [saved] }),
  );
  const afterStep = await s.retry();
  await s.control((ctx) =>
    ctx.runMutation(api.messages.deleteByIds, {
      messageIds: [s.ids.promptMessageId],
    }),
  );
  go.open();
  await job;
  expect({
    afterStep,
    afterPrompt: await s.retry(),
    pending: (await s.docs()).filter((m) => m.status === "pending"),
  }).toEqual({ afterStep: s.jobId, afterPrompt: null, pending: [] });
});

test("the job's own streams.fail fails the turn; from the app it is a stop", async () => {
  const out: Record<string, unknown> = {};
  for (const by of ["job", "app"]) {
    let streamId!: string;
    let row!: string;
    const ready = gate();
    const done = gate();
    attempts.push(async (ctx, ids) => {
      const own = await begin(ctx, ids);
      streamId = own.streamId!;
      row = own.messages[0]._id;
      await delta(ctx, streamId, "Half.");
      if (by === "job") {
        await ctx.runMutation(api.streams.fail, { streamId, reason: "Broke." });
      }
      ready.open();
      await done.opened;
      if (by === "app") {
        await fill(ctx, ids.threadId, row, [assistant("Half.")]);
      }
    });
    const s = await submitted();
    const job = s.drain();
    await ready.opened;
    if (by === "app") {
      await s.control((ctx) =>
        ctx.runMutation(api.streams.fail, { streamId, reason: "Broke." }),
      );
    }
    done.open();
    await job;
    const [, reply] = await s.docs();
    out[by] = [reply.status, reply.text, reply.error];
  }
  expect(out).toEqual({
    job: ["failed", "Half.", "Broke."],
    app: ["failed", "Half.", "Broke."],
  });
});

test("a system row saved by the job doesn't answer its turn", async () => {
  let stopped: unknown;
  attempts.push(async (ctx, ids) => {
    await ctx.runMutation(api.messages.addMessages, {
      ...ids,
      messages: [{ message: { role: "system", content: "Audit note." } }],
    });
    stopped = await ctx.runMutation(api.messages.abortGeneration, ids);
  });
  const s = await submitted();
  await s.drain();
  expect(stopped).toBe(true);
});

test("a send at the job's own prompt leaves the prompt with its turn, so a stop by that prompt revokes the job", async () => {
  let late: unknown;
  attempts.push(async (ctx, ids) => {
    const { streamId } = await begin(ctx, ids);
    await delta(ctx, streamId!, "First.");
    await ctx.runMutation(api.messages.addMessages, {
      ...ids,
      messages: [pending],
      generate: await createFunctionHandle(generate),
    });
    await ctx.runMutation(api.messages.abortGeneration, ids);
    late = await delta(ctx, streamId!, " More.", 1);
  });
  const s = await submitted();
  await s.drain();
  expect(late).toBe(false);
});

test("streams.abort is a stop whoever calls it: the job's own abort keeps the reply", async () => {
  attempts.push(async (ctx, ids) => {
    const { streamId } = await begin(ctx, ids);
    await delta(ctx, streamId!, "Half.");
    await ctx.runMutation(api.streams.abort, { streamId, reason: "Stopped" });
  });
  const s = await submitted();
  await s.drain();
  const [, reply] = await s.docs();
  expect([reply.status, reply.text, reply.error]).toEqual([
    "failed",
    "Half.",
    "Stopped",
  ]);
});

test("a revoked job can't fill a plain pending row", async () => {
  const s = await submitted();
  const plain = await s.control((ctx) =>
    ctx.runMutation(api.messages.addMessages, {
      threadId: s.ids.threadId,
      messages: [pending],
    }),
  );
  let late: unknown;
  attempts.push(async (ctx, ids) => {
    await ctx.runMutation(api.messages.abortGeneration, ids);
    late = await tried(
      fill(ctx, ids.threadId, plain.messages[0]._id, [assistant("Late.")]),
    );
  });
  await s.drain();
  expect(late).toEqual({
    ok: false,
    error: "The generation was stopped or replaced",
  });
});

/** A job that streams "Half." and waits; the stop lands while it waits. */
function stoppedMidStream(
  after: (
    ctx: Ctx,
    ids: Ids,
    row: string,
    streamId: string,
  ) => Promise<unknown>,
) {
  const streaming = gate();
  const stopped = gate();
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    await delta(ctx, own.streamId!, "Half.");
    streaming.open();
    await stopped.opened;
    await after(ctx, ids, own.messages[0]._id, own.streamId!);
  });
  return { streaming, stopped };
}

// A stop that read the delta log would conflict with every delta the job
// writes meanwhile, so under load it could not commit.
test("a stop reads no deltas while its job runs: the job's next save is its reply's ending", async () => {
  const seen: Record<string, unknown> = {};
  const { streaming, stopped } = stoppedMidStream(
    async (ctx, ids, row, streamId) => {
      seen.late = await delta(ctx, streamId, " More.", 1);
      await fill(ctx, ids.threadId, row, [assistant("Half."), pending]);
    },
  );
  const s = await submitted();
  const job = s.drain();
  await streaming.opened;
  expect(await s.stop()).toBe(true);
  const [, atStop] = await s.docs();
  stopped.open();
  await job;
  const [, reply, ...rest] = await s.docs();
  expect({
    atStop: [atStop.status, atStop.text ?? ""],
    late: seen.late,
    reply: [reply.status, reply.text, reply.error],
    rest: rest.length,
    streaming: (await s.streams()).filter((x) => x.status === "streaming"),
  }).toEqual({
    atStop: ["pending", ""],
    late: false,
    reply: ["failed", "Half.", "Stopped"],
    rest: 0,
    streaming: [],
  });
});

test("a stopped job that dies before its next save has its reply ended by its stream's timeout", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { streaming, stopped } = stoppedMidStream(async () => {
    throw new Error("crashed");
  });
  const s = await submitted();
  const job = s.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1));
  await streaming.opened;
  await s.stop();
  stopped.open();
  await job;
  const [, open] = await s.docs();
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
  const [, reply] = await s.docs();
  expect({
    open: open.status,
    reply: [reply.status, reply.text, reply.error],
  }).toEqual({ open: "pending", reply: ["failed", "Half.", "Stopped"] });
});

test("a retry of a stopped turn whose job died ends its reply as stopped and runs nothing", async () => {
  const { streaming, stopped } = stoppedMidStream(async () => {
    throw new Error("crashed");
  });
  const s = await submitted();
  const job = s.drain();
  await streaming.opened;
  await s.stop();
  stopped.open();
  await job;
  const retried = await s.retry();
  await s.drain();
  const [, reply] = await s.docs();
  expect({
    retried,
    jobs,
    reply: [reply.status, reply.text, reply.error],
  }).toEqual({
    retried: null,
    jobs: 1,
    reply: ["failed", "Half.", "Stopped"],
  });
});

test("the next prompt saved in the thread ends a stopped reply from its stream, before the stopped job settles", async () => {
  const { streaming, stopped } = stoppedMidStream(async () => {});
  const s = await submitted();
  const job = s.drain();
  await streaming.opened;
  await s.stop();
  await s.control((ctx) =>
    ctx.runMutation(api.messages.addMessages, {
      threadId: s.ids.threadId,
      messages: [{ message: { role: "user", content: "Next." } }],
    }),
  );
  const [, reply] = await s.docs();
  stopped.open();
  await job;
  expect([reply.status, reply.text, reply.error]).toEqual([
    "failed",
    "Half.",
    "Stopped",
  ]);
});

test.each(["prompt", "order", "stream"] as const)(
  "a stop by %s that leaves its reply to the running job still has it ended by the thread's next prompt",
  async (by) => {
    const { streaming, stopped } = stoppedMidStream(async () => {});
    const s = await submitted();
    const job = s.drain();
    await streaming.opened;
    const [prompt] = await s.docs();
    const [stream] = await s.streams();
    await s.control((ctx) =>
      by === "prompt"
        ? ctx.runMutation(api.messages.abortGeneration, {
            ...s.ids,
            reason: "Stopped",
          })
        : by === "order"
          ? ctx.runMutation(api.streams.abortByOrder, {
              threadId: s.ids.threadId,
              order: prompt.order,
              reason: "Stopped",
            })
          : ctx.runMutation(api.streams.abort, {
              streamId: stream.streamId,
              reason: "Stopped",
            }),
    );
    const [, atStop] = await s.docs();
    await s.control((ctx) =>
      ctx.runMutation(api.messages.addMessages, {
        threadId: s.ids.threadId,
        messages: [{ message: { role: "user", content: "Next." } }],
      }),
    );
    const [, reply] = await s.docs();
    stopped.open();
    await job;
    expect({
      atStop: atStop.status,
      reply: [reply.status, reply.text, reply.error],
    }).toEqual({
      atStop: "pending",
      reply: ["failed", "Half.", "Stopped"],
    });
  },
);

test("a regenerate's failPendingSteps ends a stopped reply as stopped, and the stopped job's ending save is then a no-op", async () => {
  let late: unknown;
  const { streaming, stopped } = stoppedMidStream(async (ctx, ids, row) => {
    late = (await tried(fill(ctx, ids.threadId, row, [assistant("Late.")]))).ok;
  });
  const s = await submitted();
  const job = s.drain();
  await streaming.opened;
  await s.stop();
  await s.control((ctx) =>
    ctx.runMutation(api.messages.addMessages, {
      ...s.ids,
      failPendingSteps: true,
      messages: [pending],
    }),
  );
  stopped.open();
  await job;
  const [, reply] = await s.docs();
  expect({
    reply: [reply.status, reply.text, reply.error],
    late,
  }).toEqual({
    reply: ["failed", "Half.", "Stopped"],
    late: true,
  });
});

test("a stopped job whose reply another path already ended gets one verdict: its close returns true and its saves are no-ops", async () => {
  const seen: Record<string, unknown> = {};
  const { streaming, stopped } = stoppedMidStream(
    async (ctx, ids, row, streamId) => {
      seen.fail = await ctx.runMutation(api.streams.fail, {
        streamId,
        reason: "Aborted.",
      });
      seen.finish = (
        await tried(ctx.runMutation(api.streams.finish, { streamId }))
      ).ok;
      seen.fill = (
        await tried(fill(ctx, ids.threadId, row, [assistant("Late.")]))
      ).ok;
      seen.finalize = (
        await tried(
          ctx.runMutation(api.messages.finalizeMessage, {
            messageId: row,
            result: { status: "success" },
          }),
        )
      ).ok;
    },
  );
  const s = await submitted();
  const job = s.drain();
  await streaming.opened;
  await s.stop();
  await s.control((ctx) =>
    ctx.runMutation(api.messages.addMessages, {
      threadId: s.ids.threadId,
      messages: [{ message: { role: "user", content: "Next." } }],
    }),
  );
  stopped.open();
  await job;
  const [, reply] = await s.docs();
  expect({
    ...seen,
    reply: [reply.status, reply.text, reply.error],
  }).toEqual({
    fail: true,
    finish: true,
    fill: true,
    finalize: true,
    reply: ["failed", "Half.", "Stopped"],
  });
});

test("when the app answers a turn, the job's open row elsewhere ends with what it streamed", async () => {
  const ready = gate();
  const done = gate();
  const seen: Record<string, string> = {};
  attempts.push(async (ctx, ids) => {
    seen.own = (await begin(ctx, ids)).messages[0]._id;
    const away = await ctx.runMutation(api.messages.addMessages, {
      threadId: ids.threadId,
      order: 5,
      messages: [pending],
      createStream: { format: "UIMessageChunk" },
    });
    seen.away = away.messages[0]._id;
    await delta(ctx, away.streamId, "Away.");
    ready.open();
    await done.opened;
  });
  const s = await submitted();
  const job = s.drain();
  await ready.opened;
  await s.control((ctx) =>
    fill(ctx, s.ids.threadId, seen.own, [assistant("Answer.")]),
  );
  done.open();
  await job;
  const away = (await s.docs()).find((m) => m._id === seen.away)!;
  expect([away.status, away.text]).toEqual(["success", "Away."]);
});

test("a generation begun at a prompt takes over the newest live turn that prompt prompts, even one a later send started", async () => {
  const ready = gate();
  const go = gate();
  let late: unknown;
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    await fill(ctx, ids.threadId, own.messages[0]._id, [assistant("Done.")]);
  });
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    ready.open();
    await go.opened;
    late = await delta(ctx, own.streamId!, "Late.");
  });
  const s = await submitted();
  await s.drain();
  await s.control(async (ctx) =>
    ctx.runMutation(api.messages.addMessages, {
      ...s.ids,
      messages: [pending],
      generate: await createFunctionHandle(generate),
    }),
  );
  const job = s.drain();
  await ready.opened;
  await s.control((ctx) => begin(ctx, s.ids));
  go.open();
  await job;
  expect(late).toBe(false);
});

test("a send at a new order leaves an older crashed turn running and retryable (D6)", async () => {
  attempts.push(async (ctx, ids) => {
    await begin(ctx, ids);
    throw new Error("crashed");
  });
  attempts.push(async () => {});
  attempts.push(async () => {});
  const s = await submitted();
  await s.drain();
  await s.control(async (ctx) =>
    ctx.runMutation(api.messages.addMessages, {
      threadId: s.ids.threadId,
      messages: [{ message: { role: "user", content: "Later." } }],
      generate: await createFunctionHandle(generate),
    }),
  );
  await s.drain();
  const retried = await s.control((ctx) =>
    ctx.runMutation(api.messages.retryGeneration, s.ids),
  );
  await s.drain();
  expect(typeof retried).toBe("string");
});

test("a stop by stream id is control: another thread's job stops a turn's stream, and the turn's job is refused after it", async () => {
  const started = gate();
  const go = gate();
  let streamId!: string;
  let own: boolean | undefined;
  let stopped: unknown;
  attempts.push(async (ctx, ids) => {
    streamId = (await begin(ctx, ids)).streamId!;
    started.open();
    await go.opened;
    own = await delta(ctx, streamId, "Late");
  });
  attempts.push(async (ctx) => {
    await started.opened;
    stopped = await tried(
      ctx.runMutation(api.streams.abort, { streamId, reason: "Stopped" }),
    );
    go.open();
  });
  const s = await submitted();
  await s.control(async (ctx) => {
    const other = await ctx.runMutation(api.threads.createThread, {});
    await ctx.runMutation(api.messages.addMessages, {
      threadId: other._id,
      messages: [{ message: { role: "user", content: "Elsewhere." } }],
      generate: s.handle,
    });
  });
  await s.drain();
  expect({ stopped, own }).toEqual({
    stopped: { ok: true, value: true },
    own: false,
  });
});

test("a send at a new order leaves an older turn whose job returned without answering open, and retryGeneration fails it (D6, E4)", async () => {
  attempts.push(async (ctx, ids) => {
    await ctx.runMutation(api.messages.addMessages, {
      ...ids,
      messages: [{ message: { role: "system", content: "Noted." } }],
    });
  });
  attempts.push(async () => {});
  const s = await submitted();
  await s.drain();
  await s.control(async (ctx) =>
    ctx.runMutation(api.messages.addMessages, {
      threadId: s.ids.threadId,
      messages: [{ message: { role: "user", content: "Later." } }],
      generate: await createFunctionHandle(generate),
    }),
  );
  await s.drain();
  const openAfterSend = !(await s.docs()).some((m) => m.status === "failed");
  const retried = await s.control((ctx) =>
    ctx.runMutation(api.messages.retryGeneration, s.ids),
  );
  const failed = (await s.docs()).find((m) => m.status === "failed");
  expect({ openAfterSend, retried, error: failed?.error }).toEqual({
    openAfterSend: true,
    retried: null,
    error: "The generation returned without answering",
  });
});

test("a stop reaches a send's pending row that sits before its prompt's order", async () => {
  const t = createTest();
  const handle = await t.mutation(() => createFunctionHandle(generate));
  const pendingLeft = await t.mutation(async (ctx) => {
    const thread = await ctx.runMutation(api.threads.createThread, {});
    await ctx.runMutation(api.messages.addMessages, {
      threadId: thread._id,
      messages: [
        { message: { role: "user", content: "A." } },
        { message: { role: "assistant", content: [] }, status: "pending" },
        { message: { role: "user", content: "B." } },
      ],
      generate: handle,
    });
    await ctx.runMutation(api.messages.abortGeneration, {
      threadId: thread._id,
    });
    const { page } = await ctx.runQuery(api.messages.listMessagesByThreadId, {
      threadId: thread._id,
      order: "asc",
      statuses: ["pending"],
      paginationOpts: { numItems: 10, cursor: null },
    });
    return page.length;
  });
  expect(pendingLeft).toBe(0);
});

test("ending a turn ends the row and stream its job opened in another thread", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const ready = gate();
  const done = gate();
  let away!: { threadId: string; streamId: string };
  attempts.push(async (ctx, ids) => {
    await begin(ctx, ids);
    const other = await ctx.runMutation(api.threads.createThread, {});
    const saved = await ctx.runMutation(api.messages.addMessages, {
      threadId: other._id,
      messages: [pending],
      createStream: { format: "UIMessageChunk" },
    });
    away = { threadId: other._id, streamId: saved.streamId };
    await delta(ctx, saved.streamId, "Away.");
    ready.open();
    await done.opened;
  });
  const s = await submitted();
  const job = s.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1));
  await ready.opened;
  await s.stop();
  done.open();
  await job;
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
  const left = await s.t.query(async (ctx) => ({
    rows: (
      await ctx.runQuery(api.messages.listMessagesByThreadId, {
        threadId: away.threadId,
        order: "asc",
        statuses: ["pending"],
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).page.length,
    streams: (
      await ctx.runQuery(api.streams.list, {
        threadId: away.threadId,
        statuses: ["streaming"],
      })
    ).length,
  }));
  expect(left).toEqual({ rows: 0, streams: 0 });
});

test("a stop by a plain prompt aborts its inline generation's stream and leaves the reply to it, as on main", async () => {
  const t = createTest();
  const stop = await t.mutation(async (ctx) => {
    const thread = await ctx.runMutation(api.threads.createThread, {});
    const threadId = thread._id;
    const sent = await ctx.runMutation(api.messages.addMessages, {
      threadId,
      messages: [{ message: { role: "user", content: "Go." } }],
    });
    const promptMessageId = sent.messages[0]._id;
    await ctx.runMutation(api.messages.addMessages, {
      threadId,
      promptMessageId,
      messages: [
        { message: { role: "assistant", content: [] }, status: "pending" },
      ],
      createStream: { format: "UIMessageChunk" },
    });
    return { threadId, promptMessageId };
  });
  const stopped = await t.mutation((ctx) =>
    ctx.runMutation(api.messages.abortGeneration, {
      ...stop,
      reason: "Stopped",
    }),
  );
  const { page } = await t.query((ctx) =>
    ctx.runQuery(api.messages.listMessagesByThreadId, {
      threadId: stop.threadId,
      order: "asc",
      statuses: ["pending", "success", "failed"],
      paginationOpts: { numItems: 10, cursor: null },
    }),
  );
  const streams = await t.query((ctx) =>
    ctx.runQuery(api.streams.list, {
      threadId: stop.threadId,
      statuses: ["streaming", "aborted"],
    }),
  );
  expect({
    stopped,
    reply: page.at(-1)?.status,
    streams: streams.map((s) => s.status),
  }).toEqual({ stopped: true, reply: "pending", streams: ["aborted"] });
});

test("a step save whose reply is lost: failing the row it filled fails the new pending row, and the turn ends", async () => {
  let finalized: unknown;
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    await delta(ctx, own.streamId!, "Half.");
    // The step save commits, but its reply never reaches the job.
    await fill(ctx, ids.threadId, own.messages[0]._id, [
      assistant([call("c1")]),
      { message: result("c1") },
      pending,
    ]);
    finalized = await tried(
      ctx.runMutation(api.messages.finalizeMessage, {
        messageId: own.messages[0]._id,
        result: { status: "failed", error: "lost reply" },
      }),
    );
  });
  const s = await submitted();
  await s.drain();
  expect({
    finalized,
    rows: (await s.docs()).map((m) => [m.message?.role, m.status, m.error]),
    streams: (await s.streams()).map((x) => x.status),
    retry: await s.retry(),
  }).toEqual({
    finalized: { ok: true, value: null },
    rows: [
      ["user", "success", undefined],
      ["assistant", "success", undefined],
      ["tool", "success", undefined],
      ["assistant", "failed", "lost reply"],
    ],
    streams: ["aborted"],
    retry: null,
  });
});

test("the app's updateMessage failing a job's open row aborts its stream, and the job's fill is refused", async () => {
  const go = gate();
  const seen: { row?: string; ready?: true; fill?: unknown } = {};
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    seen.row = own.messages[0]._id;
    await delta(ctx, own.streamId!, "Half.");
    seen.ready = true;
    await go.opened;
    seen.fill = await tried(
      fill(ctx, ids.threadId, own.messages[0]._id, [assistant("Late.")]),
    );
  });
  const s = await submitted();
  const job = s.drain();
  while (!seen.ready) await new Promise((r) => setTimeout(r, 2));
  await s.control((ctx) =>
    ctx.runMutation(api.messages.updateMessage, {
      messageId: seen.row,
      patch: { status: "failed", error: "Failed by the app" },
    }),
  );
  const streams = (await s.streams()).map((x) => x.status);
  go.open();
  await job;
  expect({ streams, fill: seen.fill, rows: await s.rows() }).toEqual({
    streams: ["aborted"],
    fill: { ok: false, error: "The generation was stopped or replaced" },
    rows: [
      ["user", "success", "Go."],
      ["assistant", "failed", undefined],
    ],
  });
});

test("a job that waits on a tool, opens a new step and crashes leaves its turn retryable", async () => {
  attempts.push(async (ctx, ids) => {
    await ctx.runMutation(api.messages.addMessages, {
      ...ids,
      messages: [{ message: { role: "assistant", content: [call("a")] } }],
    });
    await begin(ctx, ids);
    throw new Error("crashed");
  });
  attempts.push(async () => {});
  const s = await submitted();
  await s.drain();
  const retried = await s.retry();
  await s.drain();
  expect(typeof retried).toBe("string");
});

test("deleting a prompt a second send reused ends that send's turn too", async () => {
  const go = gate();
  const late: { ok: boolean }[] = [];
  const job = async (ctx: Ctx, ids: Ids) => {
    await go.opened;
    late.push(
      await tried(
        ctx.runMutation(api.messages.addMessages, {
          threadId: ids.threadId,
          messages: [assistant("Late.")],
        }),
      ),
    );
  };
  attempts.push(job, job);
  const s = await submitted();
  await s.control(async (ctx) =>
    ctx.runMutation(api.messages.addMessages, {
      ...s.ids,
      messages: [pending],
      generate: await createFunctionHandle(generate),
    }),
  );
  await s.control((ctx) =>
    ctx.runMutation(api.messages.deleteByIds, {
      messageIds: [s.ids.promptMessageId],
    }),
  );
  go.open();
  await s.drain();
  expect(late.filter((r) => r.ok)).toEqual([]);
});

test("a job still running when its thread is deleted keeps its record, so it is refused even in another thread", async () => {
  const ready = gate();
  const go = gate();
  const s = await submitted();
  const { _id: other } = await s.control((ctx) =>
    ctx.runMutation(api.threads.createThread, {}),
  );
  let late!: { ok: boolean };
  attempts.push(async (ctx) => {
    ready.open();
    await go.opened;
    late = await tried(
      ctx.runMutation(api.messages.addMessages, {
        threadId: other,
        messages: [assistant("Late.")],
      }),
    );
  });
  const job = s.drain();
  await ready.opened;
  await s.control((ctx) =>
    ctx.runMutation(api.threads.deleteAllForThreadIdAsync, {
      threadId: s.ids.threadId,
    }),
  );
  go.open();
  await job;
  expect(late.ok).toBe(false);
});

test("a step whose three tool calls have two results saved one at a time leaves the turn live", async () => {
  const go = gate();
  const ready = gate();
  attempts.push(async (ctx, ids) => {
    await ctx.runMutation(api.messages.addMessages, {
      ...ids,
      messages: [assistant(["a", "b", "c"].map(call))],
    });
    for (const id of ["a", "b"]) {
      await ctx.runMutation(api.messages.addMessages, {
        ...ids,
        messages: [{ message: result(id) }],
      });
    }
    ready.open();
    await go.opened;
  });
  const s = await submitted();
  const job = s.drain();
  await ready.opened;
  const stopped = await s.stop();
  go.open();
  await job;
  expect(stopped).toBe(true);
});

test("a stop reads no deltas of a stream its job has open in another thread", async () => {
  const stopReads = async (deltas: number) => {
    const ready = gate();
    const go = gate();
    attempts.push(async (ctx, ids) => {
      await begin(ctx, ids);
      const other = await ctx.runMutation(api.threads.createThread, {});
      const away = await ctx.runMutation(api.messages.addMessages, {
        threadId: other._id,
        messages: [pending],
        createStream: { format: "UIMessageChunk" },
      });
      for (let i = 0; i < deltas; i++) await delta(ctx, away.streamId, "x", i);
      ready.open();
      await go.opened;
    });
    const s = await submitted();
    const job = s.drain();
    await ready.opened;
    const read = await s.control(async (ctx) => {
      await ctx.runMutation(api.messages.abortGeneration, s.ids);
      const meta = (ctx as unknown as { meta: Metered }).meta;
      return (await meta.getTransactionMetrics()).documentsRead.used;
    });
    go.open();
    await job;
    return read;
  };
  expect(await stopReads(30)).toBe(await stopReads(1));
});

test("a plain streams.finish reads and writes as on main", async () => {
  const t = createTest();
  const used = await t.mutation(async (ctx) => {
    const thread = await ctx.runMutation(api.threads.createThread, {});
    const streamId = await ctx.runMutation(api.streams.create, {
      threadId: thread._id,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk",
    });
    const meta = (ctx as unknown as { meta: Metered }).meta;
    const before = await meta.getTransactionMetrics();
    await ctx.runMutation(api.streams.finish, { streamId });
    const after = await meta.getTransactionMetrics();
    return {
      read: after.documentsRead.used - before.documentsRead.used,
      written: after.documentsWritten.used - before.documentsWritten.used,
    };
  });
  expect(used).toEqual({ read: 3, written: 1 });
});

test("a waiting turn whose job opens a stream at its prompt and crashes stays retryable", async () => {
  attempts.push(async (ctx, ids) => {
    await ctx.runMutation(api.messages.addMessages, {
      ...ids,
      messages: [assistant([call("a")])],
    });
    await ctx.runMutation(api.streams.create, {
      threadId: ids.threadId,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk",
      promptMessageId: ids.promptMessageId,
    });
    throw new Error("crashed");
  });
  attempts.push(async () => {});
  const s = await submitted();
  await s.drain();
  const retried = await s.retry();
  await s.drain();
  expect(typeof retried).toBe("string");
});

test("a stop by a prompt stops every live turn it prompts, including one its job sent there", async () => {
  const ready = gate();
  const go = gate();
  let late!: { ok: boolean };
  const s = await submitted();
  attempts.push(async (ctx, ids) => {
    await ctx.runMutation(api.messages.addMessages, {
      ...ids,
      messages: [pending],
      generate: s.handle,
    });
  });
  attempts.push(async (ctx, ids) => {
    ready.open();
    await go.opened;
    late = await tried(
      ctx.runMutation(api.messages.addMessages, {
        ...ids,
        messages: [assistant("B answer.")],
      }),
    );
  });
  const job = s.drain();
  await ready.opened;
  await s.control((ctx) =>
    ctx.runMutation(api.messages.abortGeneration, s.ids),
  );
  go.open();
  await job;
  expect(late.ok).toBe(false);
});

test("a stopped row left open in another thread ends when that thread gets a prompt", async () => {
  const ready = gate();
  const go = gate();
  const s = await submitted();
  const { _id: other } = await s.control((ctx) =>
    ctx.runMutation(api.threads.createThread, {}),
  );
  attempts.push(async (ctx) => {
    const saved = await ctx.runMutation(api.messages.addMessages, {
      threadId: other,
      messages: [pending],
      createStream: { format: "UIMessageChunk" },
    });
    await delta(ctx, saved.streamId!, "Side.");
    ready.open();
    await go.opened;
  });
  const job = s.drain();
  await ready.opened;
  await s.stop();
  await s.control((ctx) =>
    ctx.runMutation(api.messages.addMessages, {
      threadId: other,
      messages: [{ message: { role: "user", content: "Next." } }],
    }),
  );
  const [row] = (
    await s.t.query((ctx) =>
      ctx.runQuery(api.messages.listMessagesByThreadId, {
        threadId: other,
        order: "asc",
        statuses: ["pending", "success", "failed"],
        paginationOpts: { numItems: 10, cursor: null },
      }),
    )
  ).page;
  go.open();
  await job;
  expect([row.status, row.error, row.text]).toEqual([
    "failed",
    "Stopped",
    "Side.",
  ]);
});

test("deleting a thread with more running jobs than a page completes while they run", async () => {
  const go = gate();
  const all = gate();
  let started = 0;
  for (let i = 0; i < 101; i++) {
    attempts.push(async () => {
      if (++started === 101) all.open();
      await go.opened;
    });
  }
  const s = await submitted();
  for (let i = 0; i < 100; i++) {
    await s.control((ctx) =>
      ctx.runMutation(api.messages.addMessages, {
        threadId: s.ids.threadId,
        messages: [{ message: { role: "user", content: "Again." } }],
        generate: s.handle,
      }),
    );
  }
  await all.opened;
  await s.control((ctx) =>
    ctx.runMutation(api.threads.deleteAllForThreadIdAsync, {
      threadId: s.ids.threadId,
    }),
  );
  const gone = await vi
    .waitFor(
      async () => {
        const thread = await s.t.query((ctx) =>
          ctx.runQuery(api.threads.getThread, { threadId: s.ids.threadId }),
        );
        if (thread) throw new Error("not yet");
      },
      { timeout: 2000, interval: 20 },
    )
    .then(
      () => true,
      () => false,
    );
  go.open();
  await s.drain();
  expect(gone).toBe(true);
}, 20000);

test("deleting a stopped turn's thread still ends the reply it left open in another thread", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const ready = gate();
  const go = gate();
  const s = await submitted();
  const { _id: other } = await s.control((ctx) =>
    ctx.runMutation(api.threads.createThread, {}),
  );
  let saved!: { messages: { _id: string }[]; streamId?: string };
  attempts.push(async (ctx) => {
    saved = await ctx.runMutation(api.messages.addMessages, {
      threadId: other,
      messages: [pending],
      createStream: { format: "UIMessageChunk" },
    });
    await delta(ctx, saved.streamId!, "keep");
    ready.open();
    await go.opened;
  });
  const job = s.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1));
  await ready.opened;
  await s.stop();
  await s.control((ctx) =>
    ctx.runMutation(api.threads.deleteAllForThreadIdAsync, {
      threadId: s.ids.threadId,
    }),
  );
  go.open();
  await job;
  await s.t.finishAllScheduledFunctions(() => vi.runAllTimers());
  const [row] = await s.t.query((ctx) =>
    ctx.runQuery(api.messages.getMessagesByIds, {
      messageIds: [saved.messages[0]._id],
    }),
  );
  expect([row?.status, row?.text]).toEqual(["failed", "keep"]);
});

test("streams.abort of a live turn's finished stream is a no-op, as for a plain one", async () => {
  const ready = gate();
  const go = gate();
  let first!: string;
  let next!: boolean;
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    first = own.streamId!;
    await delta(ctx, first, "One.");
    const saved = await fill(
      ctx,
      ids.threadId,
      own.messages[0]._id,
      [assistant([call("a")]), { message: result("a") }, pending],
      true,
    );
    ready.open();
    await go.opened;
    next = await delta(ctx, saved.streamId!, "Two.");
  });
  const s = await submitted();
  const job = s.drain();
  await ready.opened;
  const aborted = await s.control((ctx) =>
    ctx.runMutation(api.streams.abort, { streamId: first, reason: "Stale" }),
  );
  go.open();
  await job;
  expect({ aborted, next }).toEqual({ aborted: false, next: true });
});

test("abortByOrder at another thread's order leaves a stream a turn's job holds there to its turn", async () => {
  const ready = gate();
  const go = gate();
  let other!: string;
  let later!: boolean;
  attempts.push(async (ctx) => {
    other = (await ctx.runMutation(api.threads.createThread, {}))._id;
    const away = await ctx.runMutation(api.messages.addMessages, {
      threadId: other,
      messages: [pending],
      createStream: { format: "UIMessageChunk" },
    });
    await delta(ctx, away.streamId!, "Side.");
    ready.open();
    await go.opened;
    later = await delta(ctx, away.streamId!, " More.", 1);
  });
  const s = await submitted();
  const job = s.drain();
  await ready.opened;
  const aborted = await s.control((ctx) =>
    ctx.runMutation(api.streams.abortByOrder, {
      threadId: other,
      order: 0,
      reason: "Stopped",
    }),
  );
  go.open();
  await job;
  expect({ aborted, later }).toEqual({ aborted: false, later: true });
});

test("an app's fill of a live turn's open row with a call, its result and an answer ends the turn", async () => {
  const ready = gate();
  const go = gate();
  let row!: string;
  attempts.push(async (ctx, ids) => {
    row = (await begin(ctx, ids)).messages[0]._id;
    ready.open();
    await go.opened;
  });
  const s = await submitted();
  const job = s.drain();
  await ready.opened;
  await s.control((ctx) =>
    fill(ctx, s.ids.threadId, row, [
      assistant([call("a")]),
      { message: result("a") },
      assistant("Done."),
    ]),
  );
  const live = await s.stop();
  go.open();
  await job;
  expect(live).toBe(false);
});

test("a retried turn's saved steps come back in step order, with an answer between its tool steps", async () => {
  const seen: Record<string, unknown> = {};
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    await fill(ctx, ids.threadId, own.messages[0]._id, [
      assistant([call("c1")]),
      { message: result("c1") },
      assistant("Answer one."),
      assistant([call("c2")]),
      { message: result("c2") },
      pending,
    ]);
    throw new Error("crashed");
  });
  attempts.push(async (ctx, ids) => {
    const own = await begin(ctx, ids);
    seen.saved = own.turn!.saved.map((row) => [
      row.message?.role,
      row.tool,
      row.text,
    ]);
    await fill(ctx, ids.threadId, own.messages[0]._id, [assistant("Done.")]);
  });
  const s = await submitted();
  await s.drain();
  await s.retry();
  await s.drain();
  expect(seen.saved).toEqual([
    ["assistant", true, undefined],
    ["tool", true, undefined],
    ["assistant", false, "Answer one."],
    ["assistant", true, undefined],
    ["tool", true, undefined],
  ]);
});
