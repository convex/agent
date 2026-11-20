---
"@convex-dev/agent": patch
---

Keep a stream alive while its action is quiet for over 10 minutes (a long tool
call or a slow model), instead of timing it out and failing the answer with
"async abort".
