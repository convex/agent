---
"@convex-dev/agent": patch
---

Tool approvals continue from stored decisions only (#411, #454):

- A context handler sees the fetched context and can return any history. No
  approval request or decision it returns is sent.
- A decision passed in `messages` or `prompt` that is not stored throws. Save it
  with `approveToolCall`, `denyToolCall` or `respondToToolCallApprovals`.
  Approvals need a thread.
- Unresolved approvals are left out of other generations and stay pending,
  instead of being auto-denied. A model may request a left-out call again. A
  stored denial outside the fetched context is left out.
- Each provider-executed decision is sent once, and settled ones are no longer
  replayed in later prompts.
- Continuing an approval whose tool call id was reused throws, even when the
  reused call is identical.
- Fixed: resuming a sibling after a provider result in an assistant message
  threw, and a handler returning a decision ran a local approval in an unrelated
  generation.
- Threads continued before this version: a provider-executed approval continued
  with no stored result can be sent again when a sibling is resumed.
