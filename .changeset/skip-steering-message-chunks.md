---
"@convex-dev/agent": patch
---

Skip AI SDK `steering-message` stream chunks (ai 7.0.163+, with
`experimental_steering`) instead of warning in the client and failing to recover
a failed or aborted stream's output.
