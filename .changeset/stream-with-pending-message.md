---
"@convex-dev/agent": patch
---

A streamed generation starts its stream in the save of its pending message, and
failing that message (a retry, `finalizeMessage` or `updateMessage`) aborts the
stream and keeps what it streamed (#432); a streamed generation whose step save
committed but threw fails the pending message that save moved its stream to,
through `finalizeMessage`'s new `streamId` (#498); `streams.fail` ends a failed
stream; a pending message holds its stream's id until it settles (only pending
rows are one-way); `listDeltas` and `syncStreams` read another thread's stream
as missing.
