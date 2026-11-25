---
"@convex-dev/agent": patch
---

A reply restarted from the same prompt shows apart from the failed attempt it
replaced, instead of merging its partial text. Each failed attempt gets its
own bubble, and a failed attempt with no content is dropped once the restart
arrives.

The restarted reply is now its own UIMessage with its own id. Apps that key
state on the id of the first attempt will see a new id for the restart.
