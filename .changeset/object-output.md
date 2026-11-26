---
"@convex-dev/agent": patch
---

`asTextAction` takes an `output` and returns it as `output`. `generateObject`,
`streamObject`, `saveObject`, `asObjectAction` and the `imagePart` from
`storeFile`/`getFile` are deprecated in favour of `generateText`, `streamText`
or `asTextAction` with `output`, and file parts (#530).
