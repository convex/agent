---
"@convex-dev/agent": patch
---

Async thread, user, and stream deletes keep going within each scheduled
transaction while it has headroom, so they need fewer scheduled hops, and
`deleteStreamSync` no longer refuses a stream that fits in one transaction.
