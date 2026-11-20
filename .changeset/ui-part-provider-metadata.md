---
"@convex-dev/agent": patch
---

Give UI text, reasoning and tool parts their own provider metadata, so signatures and citations survive `toUIMessages` and `fromUIMessages`; a tool result's message-level `providerMetadata` now shows as `resultProviderMetadata` instead of `callProviderMetadata`.
