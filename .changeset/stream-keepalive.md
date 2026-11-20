---
"@convex-dev/agent": patch
---

Keep a stream alive while its action is quiet for over 10 minutes, such as during a long tool call, instead of timing it out with "async abort".
