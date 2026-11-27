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
    turn?: { promptMessageId: string; jobId: string };
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
    turn: { promptMessageId: s.ids.promptMessageId, jobId: s.jobId },
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

test("a stop ends the turn: its reply keeps what streamed, every stream the job holds closes, and the job is refused after", async () => {
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
    seen.lateFill = await tried(
      fill(ctx, ids.threadId, own.messages[0]._id, [assistant("Late.")]),
    );
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
    reply: [reply.status, reply.text, reply.abort],
    streams: (await s.streams()).map((x) => x.status),
    late: seen.late,
    lateFill: seen.lateFill,
    retry: await s.retry(),
  }).toEqual({
    stop: true,
    reply: ["success", "Half.", { reason: "Stopped" }],
    streams: ["aborted"],
    late: false,
    lateFill: {
      ok: false,
      error: expect.stringContaining("stopped or replaced"),
    },
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

test("an approval waits; approving with generate continues the turn, and a stop before the continuation runs marks the response", async () => {
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
  const docs = await s.docs();
  expect({
    waiting,
    continued: typeof approved.jobId,
    stop,
    marked: docs.filter((m) => m.abort).map((m) => m._id),
    jobs,
  }).toEqual({
    waiting: null,
    continued: "string",
    stop: true,
    marked: [docs.at(-1)!._id],
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
    const ready = gate();
    const done = gate();
    attempts.push(async (ctx, ids) => {
      streamId = (await begin(ctx, ids)).streamId!;
      await delta(ctx, streamId, "Half.");
      if (by === "job") {
        await ctx.runMutation(api.streams.fail, { streamId, reason: "Broke." });
      }
      ready.open();
      await done.opened;
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
    out[by] = [reply.status, reply.text, reply.abort?.reason ?? reply.error];
  }
  expect(out).toEqual({
    job: ["failed", "Half.", "Broke."],
    app: ["success", "Half.", "Broke."],
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

test("streams.abort is a stop whoever calls it: the job's own abort keeps the reply and marks it", async () => {
  attempts.push(async (ctx, ids) => {
    const { streamId } = await begin(ctx, ids);
    await delta(ctx, streamId!, "Half.");
    await ctx.runMutation(api.streams.abort, { streamId, reason: "Stopped" });
  });
  const s = await submitted();
  await s.drain();
  const [, reply] = await s.docs();
  expect([reply.status, reply.text, reply.abort?.reason]).toEqual([
    "success",
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
