---
"@convex-dev/agent": patch
---

Add a `lastTouchedBefore` cutoff to `getFilesToDelete` and `deleteFiles` for
cleaning up recent unreferenced files (#361, #437).
