---
"@convex-dev/agent": patch
---

Add `agent.addToolOutput` to save a client-side tool's result next to its call.
`generateText` and `streamText` throw instead of continuing a step whose client
calls lack outputs, so a tool result passed inline in `messages` or `prompt` no
longer answers a stored call. `createTool` accepts a tool without `execute`, and
rejects one that also sets `needsApproval` (#231).
