---
"@convex-dev/agent": patch
---

`storeFile` verifies `sha256` through storage instead of the deprecated `getMetadata`, accepts uppercase hex, and rejects an empty `sha256` instead of skipping the check.
