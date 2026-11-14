---
"@convex-dev/agent": patch
---

Store each message's text once, and its usage, provider metadata, sources and
warnings in a `messagePayloads` row when they take 2 KB or more, so prompt
context, saves and search read less. `fetchContextMessages` and message search
return what the model reads, without those fields. `listMessages` and
`listUIMessages` take `textOnly`. Saved messages have no empty `sources` or
`warnings`.
