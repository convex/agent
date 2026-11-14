---
"@convex-dev/agent": patch
---

Save every step the AI SDK runs, fail the generation when a step save fails, and
keep provider errors in `fullStream` with `saveStreamDeltas`. A caller's
`onStepEnd` now runs before its step is saved, its `onEnd` after the last one,
and a step cut off by `stopStream` fails instead of staying pending (#388, #419,
#428).
