---
"@convex-dev/agent": patch
---

A streaming generation now heartbeats its stream through quiet stretches, like a
long tool call, and retries a failed heartbeat after 15, 30 and 60 seconds, so
the stream timeout no longer aborts a live generation. A stream that times out
because its action died now fails the pending message it was filling, keeping
the text it streamed, instead of leaving it `pending`.
