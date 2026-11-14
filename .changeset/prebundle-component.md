---
"@convex-dev/agent": patch
---

Ship each component function module pre-bundled, so a call loads 2 modules
instead of up to 10: about 10 ms less per component call on Convex cloud. The
component now runs the `convex-helpers` version this package was built with, not
the app's.
