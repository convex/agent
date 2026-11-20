---
"@convex-dev/agent": patch
---

Create a streamed generation's stream with its pending message, so a retry ends the replaced attempt's stream instead of leaving it `streaming` (#432); one-way: an older component version rejects messages that carry `streamId`. A pending message can no longer be filled from another thread.
