---
"@convex-dev/agent": patch
---

Recover streamed output in `finalizeMessage` with built-in `.paginate()`, which
is faster for long or multiple streams.
Falls back to convex-helpers' `paginator` on backends that allow only one built-in `.paginate()` per mutation.
