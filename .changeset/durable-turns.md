---
"@convex-dev/agent": patch
---

The component runs durable turns: `addMessages` and `respondToToolCallApprovals`
with `generate` schedule a job that answers the save, and `retryGeneration` runs
a crashed one again. `abortGeneration`, `streams.abort` and `abortByOrder` stop
turns, ending a stopped reply failed with the stop's reason and what it
streamed, and still stop inline generations through their streams. Deleting a
prompt ends its turn and fails its pending replies, and another thread's message
id reads as missing. A durable turn's rows are one-way: older component versions
reject them.
