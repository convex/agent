---
"@convex-dev/agent": patch
---

A failed or stopped stream keeps the text it had streamed, in its deltas and its
failed message; `DeltaStreamer.handOver` is deprecated.
