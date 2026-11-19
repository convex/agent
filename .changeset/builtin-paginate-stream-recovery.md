---
"@convex-dev/agent": patch
---

Recover streamed output in `finalizeMessage` with built-in `.paginate()`, which
is faster for long or multiple streams.
