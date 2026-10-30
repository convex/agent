# Pending-message primitives (design spike)

Built on the v3 step-saves rewrite of https://github.com/convex/agent/pull/397
(`spike/step-saves-v3`), which already saves every step before the next one
starts and moves one pending message forward through the generation.

## One primitive: claim an owned pending message

The two asks, "generate into a pending message I already saved" and "answer this
prompt at most once", are the same operation: an atomic claim of a pending
message the app owns. The pending message is the idempotency key, so there is no
separate key, table or option. The stream link that #168 needs is the same
ownership seen from the stream's side: a stream belongs to the pending message
its generation saves into.

### API

```ts
// AgentPrompt, so generateText, streamText, generateObject, streamObject and
// agent.start all accept it.
pendingMessageId?: string;

// Thrown before any model call when the message can't be claimed.
export class AlreadyClaimedError extends Error {
  status: "running" | "answered";
  messageId: string; // the generation's latest message
}
```

Queue, then answer once, from anywhere (a workflow step, a webhook, a poll):

```ts
// In a mutation: exactly once, with whatever dedupe the app already has.
const { messageId: pendingMessageId } = await saveMessage(
  ctx,
  components.agent,
  {
    threadId,
    promptMessageId,
    message: { role: "assistant", content: [] },
    metadata: { status: "pending" },
  },
);

// In an action, any number of times.
try {
  await agent.generateText(ctx, { threadId }, { pendingMessageId });
} catch (error) {
  if (!(error instanceof AlreadyClaimedError)) throw error;
  // "answered": nothing to do. "running": another attempt has it.
}
```

Component additions:

- `messages.claimPendingMessage({ threadId, messageId })` (an assistant message
  in that thread) returns `{ status: "claimed", message, promptMessageId? }` or
  `{ status: "running" | "answered", messageId }`.
- `streams.create` takes an optional `pendingMessageId`.

### Semantics

The answer to a claim key `K` is `K` plus every message a claimed generation
saves after it at `K`'s order (they carry `claim.key = K`, and `claim.at`, which
identifies the attempt). The claim looks at the latest message of the latest
attempt, not the latest message in the order: a lapsed attempt's text can be
recovered after its replacement started.

| latest message                | claim result                                                                |
| ----------------------------- | --------------------------------------------------------------------------- |
| pending, never claimed        | claimed in place (the queued placeholder)                                   |
| pending, claimed < lease ago  | `running`                                                                   |
| success                       | `answered`                                                                  |
| failed                        | continue in a new pending message                                           |
| pending, claimed >= lease ago | fail it (scheduled, keeps streamed text), continue in a new pending message |

"Continue" means a new pending message at the same order with the same key; the
context includes the steps already saved there, so saved tool calls and results
are not rerun. The lease is 10 minutes, the Convex action time limit: the action
that made an older claim can no longer be running.

`startGeneration` claims before it fetches context or calls the model, and skips
`saveInputMessages` (no new pending message, no `failPendingSteps`
"Restarting"). The prompt is the pending message's `promptMessageId`. If
building the context fails after the claim, the claimed message is failed so the
next attempt can continue it.

Each claimed generation's step saves carry the claim forward (`addMessages`
copies `claim` from the pending message it replaces). Each stream records the
pending message it saves into; a step save that passes the stream moves the link
to the new pending message.

### Invariants

1. At most one live generation owns a key at a time. Claims are a single
   mutation (OCC-serialized), and a claim is only taken over once its action
   must have ended.
2. At most one successful answer per key. A second claim sees `answered` and
   never calls the model or a tool.
3. A generation that lost its message (failed by a timeout, abort or restart)
   cannot save a success: the continuing attempt writes to a new message, and
   the old generation's next save finds its own message failed and stops (the
   existing v3 rule).
4. Steps and tool results that were saved are never redone by a retry.
5. A stream timeout fails only the message its stream is linked to, recovers
   only streams linked to that message (or legacy unlinked ones), and runs the
   recovery in its own transaction, so a large delta log can't roll back the
   timeout.

### How it fits

- `generateText` / `streamText` / `generateObject` / `streamObject` /
  `agent.start`: the `pendingMessageId` option, handled once in
  `startGeneration`. `saveMessages: "none"` with `pendingMessageId` is an error.
- `saveMessage`: unchanged; it already saves a pending placeholder with
  `metadata: { status: "pending" }`.
- Component: `claimPendingMessage`, `claim` copied by `addMessages`, the stream
  link moved by `addMessages`, `timeoutStream` fails the linked message, and
  `finalizeMessage` recovers only linked streams.

### Schema (optional fields only)

- `messages.claim?: { key: Id<"messages">, at: number }`, internal: omitted from
  `MessageDoc` and from cloned threads.
- `streamingMessages.pendingMessageId?: Id<"messages">`.

No index changes. Old rows have neither field and behave as before.

### Prototype size

About 220 lines of library code (`git diff --stat` without tests and generated
code), plus about 850 lines of tests.

## What it replaces or simplifies in v3

- The "Restarting" path is no longer the only way to regenerate at a prompt's
  order: an app-owned pending message is finalized, not failed.
- The #168 ownership heuristics (finding the pending message by order and
  stepOrder when a stream is created, moving ownership by stepOrder) become an
  explicit link written by the code that already knows it.
- `finalizeMessage` recovery stops pulling a replaced generation's unsaved
  deltas into the current message.
- Apps no longer need a claim table or a "done" flag to make a generation
  at-most-once, and no longer lose a paid result when the action dies between
  their claim and the save.

## What it unlocks

- **Batch** (#150): `example/convex/batch` rewritten on the primitive. Each
  thread shows a pending answer while queued; the result is saved into it;
  overlapping polls and duplicate webhooks save once; a poll that dies after
  claiming is picked back up after the lease. The `batchItems` table, its two
  indexes, `claimItem` and `finishBatch` are gone (399 to 352 lines, with the
  pending placeholder and crash recovery added).
- **Stream timeouts** (#168): a timed-out stream fails its own pending message
  and keeps the streamed text, with concurrent generations, restarts and
  transaction limits covered by `src/component/streams.test.ts`.
- **Workflow retries**: a step that runs `generateText({ pendingMessageId })` is
  safe to retry. After a success the retry is `answered`; after a failure it
  continues from the saved steps.
- https://github.com/convex/agent/issues/432 (a retry leaves the replaced
  attempt's stream live): with the link, `failPendingSteps` can abort exactly
  the streams linked to the messages it fails, instead of guessing by order. Not
  in the prototype; about five lines on top of it.
- https://github.com/convex/agent/issues/391 (keep a stopped reply's partial
  text): stopping is "abort the stream linked to this message", and
  `finalizeMessage` now recovers only that stream's text into it, never a
  replaced attempt's. The "stopped, not failed" status is a separate decision.
- https://github.com/convex/agent/issues/352 (continue after tool approval):
  `approveToolCall` can save the approval plus a pending answer, and a scheduled
  `generateText({ pendingMessageId })` continues it. A double approval or a
  retried continuation then can't run the approved tool twice.
- Timeouts as composition: an app-level timeout is "finalize the pending message
  failed"; the running generation stops at its next save, and a retry continues
  it.

## Open questions for Ian

1. **Throw or return?** `AlreadyClaimedError` keeps `generateText`'s return type
   honest, but every idempotent caller writes the same `catch`. A `{ skipped }`
   result or a separate `agent.answer()` would avoid it.
2. **Failed is retryable.** A failed answer (provider error, timeout, user
   abort) can be continued by the next claim. Good for workflow retries, but a
   duplicate webhook after a user's stop would regenerate. Should a user abort
   be terminal?
3. **Lease.** 10 minutes assumes every claim is made inside an action. Is that
   true for HTTP actions that stream? A workflow retry within the lease gets
   `running`; should the claim instead record the action's scheduled-function
   id, or should workflows pass their own attempt key?
4. **Lapsed claims continue in a new message**, so a crashed attempt leaves a
   failed bubble before the answer. Reusing the message in place is nicer for
   batch, but needs fencing for its streams. Worth it?
5. **Scope**: should normal `promptMessageId` generations also adopt a pending
   placeholder at that order instead of failing it as "Restarting"? That would
   make the option implicit, at the cost of changing today's restart behaviour.
6. **Stream creation timing**: the link is set from the pending message when the
   stream row is created. Codex flagged that a row created after the first step
   save would link the replaced message. I couldn't reproduce it (writing deltas
   waits on creating the row, and the SDK stream waits on the deltas, even with
   a slow `streams.create`), so there is a regression test and no fix. Creating
   the row before the first step would close it for sure.
7. **Batch replay** defers to the real model once the prompt no longer ends at
   the user message, so a retried batch item doesn't replay its tool call. It is
   a recipe-level rule; should the replay model live in the library?
