---
"@convex-dev/agent": patch
---

Keep text citations, such as Anthropic's, while streaming, when saving and on
reload. This is one-way: an older component version fails schema validation on
messages saved with citations.
