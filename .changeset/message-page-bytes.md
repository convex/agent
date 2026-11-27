---
"@convex-dev/agent": patch
---

A thread's message pages stop before the 16 MiB read and return limits and ask the paginated hook to split them, so a thread with large messages lists instead of failing (#533).
