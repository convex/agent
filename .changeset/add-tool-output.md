---
"@convex-dev/agent": patch
---

Add `agent.addToolOutput` to save the output of a client tool (one without
`execute`) next to its call, once. `createTool` accepts a tool without
`execute`, and rejects one that also sets `needsApproval` (#231).
