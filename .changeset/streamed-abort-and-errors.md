---
"@convex-dev/agent": patch
---

With `saveStreamDeltas`, an abort rejects `text` with its reason instead of `AbortError`, a provider error resolves it with the partial text, and deltas end at `finish-step` without the UI `finish` chunk.
