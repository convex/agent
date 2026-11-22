---
"@convex-dev/agent": patch
---

Deprecate `generateObject`, `streamObject`, `saveObject`, `asObjectAction` and the `imagePart` from `storeFile`/`getFile` in favour of `generateText`/`streamText` with `output` and file parts; stored images now reach the model as file parts, and output-error tool parts keep their input in `input` instead of `rawInput`.
