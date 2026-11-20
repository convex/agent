---
"@convex-dev/agent": minor
---

`promptCache: true` adds Anthropic cache breakpoints on the instructions and on
the last message before the `contextMessage`, moving the second one to the
newest tool result before each step. The markers are sent, never saved, and
other providers ignore them.
