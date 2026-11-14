---
"@convex-dev/agent": patch
---

`respondToToolCallApprovals` reads messages only back to the request, and its order once, instead of the newest 100 and the order again.
