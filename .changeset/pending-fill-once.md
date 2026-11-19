---
"@convex-dev/agent": minor
---

A second save into a `pendingMessageId` that was already filled now throws
instead of overwriting the message. To change a filled message, use
`updateMessage`. Identify the error by its code with
`isPendingMessageNotPendingError(error)`, or check
`error.data.code === PENDING_MESSAGE_NOT_PENDING`; don't match the message text.
