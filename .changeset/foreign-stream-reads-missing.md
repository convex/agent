---
"@convex-dev/agent": patch
---

`listDeltas` and `syncStreams` read another thread's stream as missing instead
of throwing.
