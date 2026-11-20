---
"@convex-dev/agent": patch
---

`generateText` aborted during its last step resolves, as the AI SDK does, and a step cut off by `stopStream` fails instead of staying pending.
