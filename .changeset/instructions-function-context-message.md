---
"@convex-dev/agent": minor
---

`instructions` can be a function of the call's ctx, `threadId` and `userId`.
`contextMessage` sends message(s) after the history and prompt without saving
them, so state that changes every call doesn't break prompt caching.
