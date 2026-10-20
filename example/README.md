# Agent Example

This is an example app that uses the `@convex-dev/agent` package.

See the [Agent docs](https://docs.convex.dev/agents) for documentation.

The backend usage is in `convex/`, with folders to organize usecases. The
frontend usage is in `ui/`.

The example exercises many usecases, with the underlying code organized into
folders by category.

The main difference from your app will be:

- What models you use (currently uses `modelsForDemo.ts`)
- Usage handling - currently configures agents to use `usageHandler.ts`
- How you handle auth - currently has an example `authorizeThreadAccess`
  function.

## Running the example

```bash
git clone https://github.com/convex/agent.git
cd agent
npm run setup
npm run dev
```

## assistant-ui chat

`/chat-assistant-ui` renders the tool approval agent with
[assistant-ui](https://www.assistant-ui.com/) primitives. It uses the same
backend as the Tool Approval example (`convex/chat/approval.ts`).

- `ui/chat/assistant-ui/useConvexRuntime.ts` connects `useUIMessages` to
  `useExternalStoreRuntime`. Sending runs `sendMessage` with
  `optimisticallySendMessage`, and approvals go through `submitApproval`, which
  resumes generation once every approval in the step is answered. Stop calls
  `abortStreamByOrder`.
- `ui/chat/assistant-ui/convertMessage.ts` maps `UIMessage` parts to
  assistant-ui parts, keyed by the message's stable `key`.
- `ui/chat/assistant-ui/Thread.tsx` composes the UI from assistant-ui
  primitives.

With no provider key and no Convex AI gateway, the demo model replies with mock
text and never calls tools, so approvals need a real model (see
`convex/modelsForDemo.ts`).
