---
"@convex-dev/agent": patch
---

`generateText` and `streamText` rebuild `contextMessage` before every step and
keep it last, after the earlier steps' tool calls and results. A
`contextMessage` function also gets the step number.
