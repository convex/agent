---
"@convex-dev/agent": patch
---

Async thread, user and stream deletes do more per scheduled transaction, and `deleteStreamSync` no longer refuses a stream that fits in one.
