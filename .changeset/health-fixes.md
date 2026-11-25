---
"@convex-dev/agent": patch
---

A retry reads only its own turn's pending messages, message pages stop short
(not done) before the 16 MiB read limit, a thread deleted mid-generation ends it
as a deleted prompt does, and a retry's "Restarting" is no longer logged as an
error. A final save whose stream already timed out and was removed still saves
its answer. `GenerationStopped` is exported, so an app passing its own `onError`
to `streamText` can skip the same errors.
