---
"@convex-dev/agent": patch
---

Store a message's text only in `text` when that makes the row smaller (one-way: older component versions reject these rows); responses no longer save empty `sources` or `warnings`.
