---
"@convex-dev/agent": patch
---

`streams.finish`, `streams.abort` and `addMessages`' `finishStreamId` refuse a
final delta or stream that isn't theirs, and add no delta to a stream that
already ended.
