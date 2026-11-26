---
"@convex-dev/agent": patch
---

A thread or user deleted mid-generation ends it as a deleted prompt does and leaves none of its messages behind (an app's own save into a thread being deleted now throws, and `finalizeMessage` and `streams.abort` take an optional `threadId`), a final save whose stream timed out still saves its answer, a retry's "Restarting" is no longer logged as an error, and `GenerationStopped` is exported for an app that passes its own `onError` to `streamText`. (#518)
