---
"@convex-dev/agent": patch
---

`generateText` and `streamText` take a `pendingMessageId` to generate into a
pending message the app saved, one attempt at a time; a second attempt throws a
`TurnError` before the model call.
