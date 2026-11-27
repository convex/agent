---
"@convex-dev/agent": patch
---

Add durable tools: `createTool` takes a `mutation`, `query` or `resume` handler,
a durable job records each step's model response and its mutation results, and
a retry replays them so each runs once; `ctx.messageId` is the step's message.
