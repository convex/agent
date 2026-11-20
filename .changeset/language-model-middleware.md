---
"@convex-dev/agent": minor
---

Add `languageModelMiddleware` to the Agent config and call options: AI SDK
middleware, or a function that builds it per step from the ctx, user, thread,
prompt message, order and step number. Throw `ModelCallRefusedError` from it to
refuse a call: the pending message is deleted, finished steps stay saved, and
the error is rethrown. `usageHandler` also gets `promptMessageId`, `order` and
`stepNumber`, and `stepOrder` for objects.
