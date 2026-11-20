---
"@convex-dev/agent": minor
---

`rawRequestResponseHandler` also gets `promptMessageId`, `order`, `stepOrder`
(objects only), `stepNumber` and `durationMs`. `streamText` results have
`saved`, which resolves once every step is saved and rejects if the generation
failed. `agent.deleteAllForUser` deletes a user's threads and messages, then
schedules an optional `onComplete` mutation.
