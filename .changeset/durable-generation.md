---
"@convex-dev/agent": patch
---

Add durable generation: `saveMessage`, `saveMessages`, the approval methods and
`addToolOutput` take a `generate` action that answers the save as a scheduled
job, `agent.retryGeneration` resumes it after its saved steps, and
`agent.abortGeneration` stops it; `DeltaStreamer.fail` reports whether its
close ended the reply.
