---
"@convex-dev/agent": patch
---

Stored images reach the model as file parts, and output-error tool parts keep
their input in `input` instead of `rawInput`. (#519)
