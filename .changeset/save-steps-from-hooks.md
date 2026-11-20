---
"@convex-dev/agent": patch
---

Save every step the AI SDK runs, including one a steering message continues past, and keep provider errors in `fullStream` with `saveStreamDeltas` (#388, #428). A failed step save fails the generation instead of retrying with the next step (#419).
