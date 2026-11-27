---
"@convex-dev/agent": patch
---

Deleting a thread or a user also deletes messages saved while it runs, and
saving to a deleted thread throws even with a `userId` (#542).
