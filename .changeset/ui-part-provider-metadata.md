---
"@convex-dev/agent": patch
---

Give UI text, reasoning and tool parts their own provider metadata, as the AI
SDK's UI message stream does, so signatures and citations survive a
`toUIMessages` and `fromUIMessages` round trip.
Tool results saved with message-level `providerMetadata` now list it as the tool
part's `resultProviderMetadata` instead of `callProviderMetadata`.
