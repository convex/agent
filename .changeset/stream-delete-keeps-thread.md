---
"@convex-dev/agent": patch
---

`streams.deleteAllStreamsForThreadIdAsync` deletes only the thread's streams and
no longer deletes the thread row; use `threads.deleteAllForThreadIdAsync` to
delete a thread (#539).
