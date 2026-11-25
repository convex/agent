---
"@convex-dev/agent": patch
---

Create a streamed generation's stream with its pending message, so a retry ends the replaced attempt's stream instead of leaving it `streaming` (#432). `finalizeMessage` with `status: "failed"` on a streamed pending message also aborts its stream, and the running attempt's later save is dropped and throws that error. A pending message can no longer be filled from another thread.

Downgrading is one-way once messages carry `streamId`: an older component version's schema rejects them, so its deploy fails. To downgrade, first clear `streamId` with a mutation that runs inside the component (an app's `ctx.db` can't reach component tables), calling it until it returns `null`:

```ts
export const clearStreamIds = mutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("messages")
      .paginate({ cursor, numItems: 500 });
    for (const m of page.page) {
      if (m.streamId) {
        await ctx.db.patch("messages", m._id, { streamId: undefined });
      }
    }
    return page.isDone ? null : page.continueCursor;
  },
});
```
