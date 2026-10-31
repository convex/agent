# Pending-message primitives (design spike)

Built on the v3 step-saves rewrite of https://github.com/convex/agent/pull/397
(`spike/step-saves-v3`), which already saves every step before the next one
starts and moves one pending message forward through the generation.

## One primitive: claim an owned pending message

The two asks, "generate into a pending message I already saved" and "answer this
prompt at most once", are the same operation: an atomic claim of a pending
message the app owns. The pending message is the idempotency key, so there is no
separate key or option for apps to manage. The claim's state lives in a small
component table keyed by that message, not on the messages: the messages saved
under the key change role and status as the generation runs (a tool step, an
approval result, a recovered stream), and none of that changes what the claim
says. The stream link that #168 needs is the same ownership seen from the
stream's side: a stream belongs to the pending message its generation saves
into.

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

- `messages.claimPendingMessage({ threadId, messageId })` returns
  `{ status: "claimed", message, promptMessageId? }` or
  `{ status: "running" | "answered", messageId }`. The first claim needs a
  pending (or failed) assistant message in that thread that no other claim is
  saving into; later claims don't look at the key's role or status.
- `messages.addMessages` takes an optional `final`: this is the last save of a
  generation that finished.
- `streams.create` takes an optional `pendingMessageId`.

### Semantics

A claim row records the key, its prompt, when the current attempt claimed it,
the current attempt's latest message (its pending message, or the last one it
saved), and whether it was answered. The prompt is copied from the key on the
first claim, because saving into the key (e.g. stream recovery) can overwrite
the key's `parentMessageId`.

| claim row                                    | claim result                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| none (key is the queued placeholder)         | claimed in place                                                                  |
| answered                                     | `answered`                                                                        |
| latest pending, claimed < lease ago          | `running`                                                                         |
| latest pending, claimed >= lease ago         | recover the lapsed attempt in this transaction, continue in a new pending message |
| latest not pending (failed, or a saved step) | continue in a new pending message                                                 |

"Continue" means a new pending message at the key's order; the context includes
the steps already saved there, so saved tool calls and results are not rerun.
The lease is 10 minutes, the Convex action time limit: the action that made an
older claim can no longer be running, so nothing it streamed can still be saved.

Where the row is written:

- `claimPendingMessage` inserts it, or moves `latestMessageId` and `claimedAt`
  to the attempt it starts.
- `addMessages` with a `pendingMessageId` that is a claim's latest message moves
  `latestMessageId` to the last message it saved, and sets `answered` only when
  the client passed `final` and that message is a success. That covers step
  saves, the final save, the held step `fail` saves, and stream recovery, in the
  same mutation as the messages.
- `deleteMessage` deletes the row of the key it deletes.

The client passes `final` from `end()` when the AI SDK finished
(`generateText`'s end, `streamText`'s `finish` part without an error) and from
`save()` without a pending message (`generateObject`, `streamObject`). It never
passes it from `fail()` or from a stream that ended without `finish` (e.g.
`stopStream`). So a failed generation's saved tool step is context for the next
attempt, never the answer.

Takeover runs `finalizeMessage(failed)` on the lapsed pending message as a
nested mutation before it creates the new one. Recovery now keeps the steps
whose tools returned as `success` (so they load as context and the tool isn't
rerun) and ends the recovered steps with a failed message, so the failure stays
visible. This applies to every failed finalize, including stream timeouts and
v3's "a failed step save" path.

Approved tools run before the first model request (the AI SDK hands their
results to `prepareStep(0)`). `beforeStep` saves those results, with a new
pending message, before that request, so an approval continuation that fails on
its first request doesn't run the approved tool again.

`startGeneration` claims before it fetches context or calls the model, and skips
`saveInputMessages` (no new pending message, no `failPendingSteps`
"Restarting"). The prompt is the key's `promptMessageId`. If building the
context fails after the claim, the claimed message is failed so the next attempt
can continue it. Each stream records the pending message it saves into; a step
save that passes the stream moves the link to the new pending message.

### Invariants

1. At most one live generation owns a key at a time. Claims are a single
   mutation (OCC-serialized on the claim row), and a claim is only taken over
   once its action must have ended.
2. At most one successful answer per key. `answered` is set only by a finished
   generation's final save, atomically with it; a later claim sees `answered`
   and never calls the model or a tool.
3. A generation that lost its message (failed by a takeover, timeout, abort or
   restart) cannot save a success or move the claim: the continuing attempt
   writes to a new message the row points at, and the old generation's next save
   finds its own message failed and stops (the existing v3 rule). Since recovery
   can now turn that message into a successful tool step, `addMessages` also
   refuses to save into a pending message that was already saved.
4. Steps and tool results that were saved, or that a lapsed attempt streamed in
   full, are never redone by a retry: takeover recovers them in the same
   transaction, before the new attempt can load its context.
5. A message's role or status never decides a claim, except that a first claim
   needs a pending or failed assistant message.
6. A stream timeout fails only the message its stream is linked to, recovers
   only streams linked to that message (or legacy unlinked ones), and runs the
   recovery in its own transaction, so a large delta log can't roll back the
   timeout.

### How it fits

- `generateText` / `streamText` / `generateObject` / `streamObject` /
  `agent.start`: the `pendingMessageId` option, handled once in
  `startGeneration`. `saveMessages: "none"` with `pendingMessageId` is an error.
- `saveMessage`: unchanged; it already saves a pending placeholder with
  `metadata: { status: "pending" }`.
- Component: `claimPendingMessage`, `addMessages`'s `final` and claim update,
  the stream link moved by `addMessages`, `timeoutStream` fails the linked
  message, and `finalizeMessage` recovers only linked streams and keeps
  completed tool steps.

### Schema

- New table `claims`: `threadId`, `messageId` (the key), `promptMessageId`,
  `claimedAt`, `latestMessageId`, `answered`. Indexes `threadId_messageId`
  (claim lookup, scoped to the thread) and `latestMessageId` (the step save that
  moves it).
- `streamingMessages.pendingMessageId?: Id<"messages">`.

Nothing on `messages`. Old rows have no claim and no link and behave as before.

### Prototype size

About 310 lines of library code (`git diff --stat` without tests and generated
code), plus about 1,570 lines of tests (library and the batch example).

## What it replaces or simplifies in v3

- The "Restarting" path is no longer the only way to regenerate at a prompt's
  order: an app-owned pending message is finalized, not failed.
- The #168 ownership heuristics (finding the pending message by order and
  stepOrder when a stream is created, moving ownership by stepOrder) become an
  explicit link written by the code that already knows it.
- `finalizeMessage` recovery stops pulling a replaced generation's unsaved
  deltas into the current message.
- Apps no longer need their own claim table or a "done" flag to make a
  generation at-most-once, and no longer lose a paid result when the action dies
  between their claim and the save.

## What it unlocks

- **Batch** (#150): `example/convex/batch` rewritten on the primitive. Each
  thread shows a pending answer while queued; the result is saved into it;
  overlapping polls and duplicate webhooks save once; a poll that dies after
  claiming is picked back up after the lease. The batch's items and pending
  answers are saved before the batch is submitted, so an action that dies
  between submitting and saving the provider's reference leaves a batch the next
  poll finds (by listing the provider's batches and matching result ids) instead
  of paid work nobody asks for. Request ids are the pending answers' ids, not
  the prompts', so a resubmitted prompt's batch is never mistaken for the lost
  one. The `batchItems` table, its two indexes, `claimItem` and `finishBatch`
  are gone.
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
2. **Failed is retryable.** A failed answer (provider error, timeout, a stopped
   stream, a throwing `stopWhen`) can be continued by the next claim. Good for
   workflow retries, but a duplicate webhook after a user's stop would
   regenerate. Should a user abort be terminal (a third claim state)?
3. **Lease.** 10 minutes assumes every claim is made inside an action. Is that
   true for HTTP actions that stream? A workflow retry within the lease gets
   `running`; should the claim instead record the action's scheduled-function
   id, or should workflows pass their own attempt key?
4. **Lapsed claims continue in a new message**, so a crashed attempt leaves a
   failed bubble before the answer. Reusing the message in place is nicer for
   batch, but needs fencing for its streams. Worth it?
5. **Recovered tool steps are now `success` for every failed finalize**, not
   only takeovers (a timed-out stream's finished tool step becomes context, and
   a failed message follows it). One rule, but it changes what a timeout leaves
   in a thread. Parallel tool calls with only some results streamed keep the
   step failed only if no tool message follows; is the AI SDK fine with a
   recovered call whose result is missing?
6. **Recovery inside the takeover** reads the lapsed stream's deltas in the
   claim mutation. `finalizeMessage` bounds that read and falls back to failing
   without recovery, in which case a streamed-but-unsaved tool would run again.
   I chose liveness: refusing the takeover would leave the key `running`
   forever, since the delta log never shrinks. Codex flags this as high; the
   alternatives are recovering in pages across transactions before the takeover,
   or a terminal "unrecoverable" claim state for the app to resolve.
7. **Scope**: should normal `promptMessageId` generations also adopt a pending
   placeholder at that order instead of failing it as "Restarting"? That would
   make the option implicit, at the cost of changing today's restart behaviour.
8. **`final` on `addMessages`** is a new component argument. It could instead be
   a separate `answerClaim` mutation, but then the answer and its save are two
   transactions, and a crash between them leaves a finished answer that a
   takeover would regenerate.
9. **Batch replay** defers to the real model once the prompt no longer ends at
   the user message, so a retried batch item doesn't replay its tool call. It is
   a recipe-level rule; should the replay model live in the library? Finding a
   lost batch also relies on `doListBatches` (OpenAI and Anthropic have it);
   without it, the items are failed after the action time limit.
10. **Stream creation timing**: the link is set from the pending message when
    the stream row is created. Codex flagged that a row created after the first
    step save would link the replaced message. I couldn't reproduce it (writing
    deltas waits on creating the row, and the SDK stream waits on the deltas,
    even with a slow `streams.create`), so there is a regression test and no
    fix. Creating the row before the first step would close it for sure.
