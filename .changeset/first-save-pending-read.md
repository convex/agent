---
"@convex-dev/agent": patch
---

A generation's first save reads only its own turn's pending messages, so
concurrent generations on one thread no longer give up and lose their reply.
