---
"@convex-dev/agent": patch
---

Add durable tools: `createTool` takes a `mutation`, `query` or `resume` handler.
A durable job's retry replays a step that ran a mutation or `execute` tool from
its recorded response and results, so each mutation runs once and an interrupted
`execute` call runs its `resume`, if any; `ctx.messageId` is the step's message.
