---
"@convex-dev/agent": patch
---

Drop the `getThread` query a generation made to find its thread's `userId`. The
first save returns it. A `contextHandler`, embedding usage, or
`saveMessages: "none"` still reads it from the thread first.
