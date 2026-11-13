---
"@convex-dev/agent": patch
---

Save every step the AI SDK runs, including one a steering message continues
past, and keep provider errors in `fullStream` with `saveStreamDeltas` (#388,
#428). A failed step save now fails the generation instead of being retried with
the next step (#419). A caller's `onStepEnd`, `usageHandler` and
`rawRequestResponseHandler` now run before the step is saved, `onEnd` after the
last save, and a step cut off by `stopStream` fails instead of staying pending.
