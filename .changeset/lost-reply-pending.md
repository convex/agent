---
"@convex-dev/agent": patch
---

Fail a streamed generation's pending message when a step save commits but its reply is lost, instead of leaving it `pending`.
