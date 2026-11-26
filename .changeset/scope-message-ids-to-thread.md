---
"@convex-dev/agent": patch
---

Message ids from another thread are treated as missing everywhere the Agent
takes one. `getMessagesByIds` takes an optional `threadId`, and
`getMessageSearchFields` optional `threadId` and `searchAllMessagesForUserId`,
to scope their lookups the same way (#529).
