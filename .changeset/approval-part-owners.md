---
"@convex-dev/agent": patch
---

Approval continuations resume after a provider-executed result and run a later
approval that reuses a completed call's `toolCallId` (#475, #476). A context
handler that reshapes a message holding a reused id, or leaves a tool call
without its result, is now refused before any tool runs.
