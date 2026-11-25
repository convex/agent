---
"@convex-dev/agent": patch
---

Fail a streamed generation's pending message when a step save commits but its reply is lost, instead of leaving it `pending`. Only the generation's own cleanup does this, through the component's `finalizeMessage` with `failStreamPending: true`; `Agent.finalizeMessage` on a message that is no longer pending still changes nothing.
