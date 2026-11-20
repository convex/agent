---
"@convex-dev/agent": patch
---

`onStepEnd`, `usageHandler` and `rawRequestResponseHandler` run before each step is saved, and `onEnd` after the last save, also after a provider error; a provider error or refused final save no longer calls `onAbort`.
