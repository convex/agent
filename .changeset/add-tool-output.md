---
"@convex-dev/agent": patch
---

Add `agent.addToolOutput` to save a client-side tool's output next to its call, once. `createTool` accepts a tool without `execute`, and rejects one that also sets `needsApproval` (#231).
