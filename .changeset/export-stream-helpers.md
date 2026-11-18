---
"@convex-dev/agent": patch
---

Export the functions that the React hooks turn stream deltas into UIMessages
with, so a client on another framework can show streaming messages:
`applyUIMessageChunksIncremental`, `blankUIMessage`, `combineUIMessages`,
`deriveUIMessagesFromDeltas`, `emptyIncrementalStreamState`, `getParts` and
`statusFromStreamStatus`.
