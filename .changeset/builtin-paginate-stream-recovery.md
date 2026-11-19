---
"@convex-dev/agent": patch
---

Recover streamed output in `finalizeMessage` with built-in `.paginate()`, which
is faster for long or multiple streams. Self-hosted backends need
precompiled-2026-10-22-db19afd or later, since one mutation recovering two
streams calls the built-in paginate twice, which older backends reject.
