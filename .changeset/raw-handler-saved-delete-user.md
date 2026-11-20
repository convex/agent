---
"@convex-dev/agent": minor
---

`rawRequestResponseHandler` also gets `promptMessageId`, `order`, `stepOrder`,
`stepNumber`, the step's `savedMessageIds` and `durationMs`, and runs after the
step is saved. `streamText` results have `saved`, which resolves once every
step is saved and rejects if the generation failed. `agent.deleteAllForUser`
deletes a user's threads and messages, then schedules an optional `onComplete`
mutation.
