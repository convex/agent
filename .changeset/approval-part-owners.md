---
"@convex-dev/agent": patch
---

Approval continuations resume after a provider-executed result and run a later approval that reuses a completed call's `toolCallId` (#475, #476); a context handler that reshapes those calls or drops a result is refused before any tool runs.
