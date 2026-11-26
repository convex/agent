---
"@convex-dev/agent": patch
---

Reloaded tool parts match the stream: they keep the tool's `title` and
`toolMetadata`, and a dynamic tool's part is `dynamic-tool` (one-way: older
component versions reject tool calls and results saved with `dynamic`).
`saveStep` takes the `tools` a step was generated with (#527).
