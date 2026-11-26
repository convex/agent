---
"@convex-dev/agent": patch
---

A thread or user deleted mid-generation ends it as a deleted prompt does and leaves none of its messages behind (an app's own save into a thread being deleted now throws), `finalizeMessage` and `streams.abort` return for a message or stream that's already gone instead of throwing, a final save whose stream timed out still saves its answer, a retry's "Restarting" is no longer logged as an error, and `GenerationStopped` is exported for an app that passes its own `onError` to `streamText`. (#518)
