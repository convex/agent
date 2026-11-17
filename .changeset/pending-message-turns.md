---
"@convex-dev/agent": patch
---

`generateText` takes a `pendingMessageId` to generate into a pending message the
app saved, one attempt at a time; a second attempt throws a `TurnError` before
the model call.
