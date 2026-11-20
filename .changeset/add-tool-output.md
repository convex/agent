---
"@convex-dev/agent": patch
---

Add `agent.addToolOutput` to save a client tool's output next to its call; `createTool` accepts a tool without `execute` unless it sets `needsApproval` (#231).
