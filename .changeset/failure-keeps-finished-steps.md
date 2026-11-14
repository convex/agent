---
"@convex-dev/agent": patch
---

Keep every step the AI SDK finished when a generation fails or is aborted, and
fail the message after them, reversing #326. Fail the pending message when a
step save commits but reports an error.
