---
"@convex-dev/agent": patch
---

A retry reads only its own turn's pending messages, message pages stop short (not done) before the 16 MiB read limit, a thread deleted mid-generation ends it as a deleted prompt does, a thread or user deletion no longer leaves behind a message a generation saved while it ran or reads a page of messages and a page of stream deltas in one transaction, a final save whose stream timed out and was removed still saves its answer, a retry's "Restarting" is no longer logged as an error, and `GenerationStopped` is exported for an app that passes its own `onError` to `streamText`.
