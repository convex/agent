---
"@convex-dev/agent": patch
---

Throw `model is required` before saving the prompt instead of leaving a pending
message, and fail the pending message an `agent.start()` save makes when the
caller aborts during it.
