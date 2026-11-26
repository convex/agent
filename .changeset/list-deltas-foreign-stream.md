---
"@convex-dev/agent": patch
---

`listDeltas` treats a stream from another thread like a deleted one and returns
no deltas for it (#526).
