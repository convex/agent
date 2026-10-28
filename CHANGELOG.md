# Changelog

## Unreleased

- Fix TS2590 when constructing Agent or calling startGeneration with large model
  catalogs or model id unions (#414, #417)
- Pass embedding providerMetadata to usageHandler (#393)
- Require ai 7.0.129 or later. Before 7.0.119 a provider error before the first
  chunk failed the action with an unhandled rejection (#387), and before 7.0.129
  approvals dropped provider options
- Don't leave a failed delta write or stream cleanup as an unhandled rejection
  (#366)
- Fix useUIMessages and useThreadMessages freezing when a page ends partway
  through a message (#395)

## 0.7.8

- Fix answering a tool approval after an earlier approval in the same thread
  (#404)

## 0.7.7

- Enforce that the stream being synced matches the thread ID associated with the
  request. (#398)

## 0.7.6

- Bounds listDeltas by bytes (#375)
- Fixes peer dependencies and updates types to match convex 1.46

## 0.7.5

- Allow tool approvals to be handled atomically and more robust (#367)

## 0.7.4

- Run agent queries and mutations inline in workflow steps (#279, #394)
- Deprecate `agent.createThreadMutation()` in favor of `createThread` (#279)
- Split the playground API so actions can run in `"use node"` (#373)
- Read the whole delta log when materializing a failed stream (#370)
- Bound async stream deletion by bytes (#369)
- Honor `cloneThread` batch options and drop dangling parent ids (#371)
- Drop the unused `refcount` index on files (#380)
- Stop mutating state during render in the streaming React hooks (#335)

## 0.7.3

- Preserve stream cleanup order across statuses (#365)
- Preserve async thread deletion limits across continuations (#363)
- Flush throttled deltas on a timer, not on the next part (#328)
- Persist opted-in source parts (#362)
- Finish the stream row when messages aren't stored (#327)
- Drain deltas at end-of-stream, not at the final step (#326)

## 0.7.2

- Preserve classified provider errors when streamed responses fail, including
  aborts racing late message writes (#320). `DeltaStreamer.getOrCreateStreamId`
  now accepts `{ ifAborted: "returnUndefined" }` for abort-aware writes; its
  existing no-argument behavior is unchanged.

- Add `hasSuccessfulToolCall(toolName)` stop-condition helper. Like the AI SDK's
  `hasToolCall` but only matches tool calls that produced a `tool-result`
  content part — failed tool calls (`tool-error` parts under AI SDK v6) do not
  match. Use when you want the agent to retry on argument-validation or runtime
  tool failures rather than stopping.

  ```ts
  import { hasSuccessfulToolCall, stepCountIs } from "@convex-dev/agent";

  await agent.streamText(
    ctx,
    { threadId },
    {
      prompt: "...",
      stopWhen: [hasSuccessfulToolCall("generateImage"), stepCountIs(5)],
    },
  );
  ```

- Fix: `willContinue` (the internal helper that decides whether to keep looping
  after a step that has tool calls) now counts `tool-error` content parts as
  completed outputs. Without this, AI SDK v6 agents would stop after a step
  where any tool call errored, even if the model had more work queued.

- Stop a generation whose prompt message was deleted (#324)
- Preserve complete message orders (#317)
- Support explicit message ordering (#319)

## 0.7.1

- Persists oversized streamed files (#307)
- fix: preserve text-part metadata on user messages (#318)

## 0.7.0

- Breaking: requires AI SDK v7, provider packages v4, provider utilities v5, and
  Node.js 22 or newer.
- Migrates generation, streaming, tools, callbacks, usage, warnings, runtime
  context, and provider types to AI SDK v7.
- Uses one `UIMessageChunk` reducer for existing v0.6 stream data and new v0.7
  streams. Existing persisted messages remain readable.
- Adds AI SDK v7 message parts, tool-result forms, approval flows, and model
  registry identifiers.
- Deprecates top-level `system` in favor of `instructions`.
- Does not yet offload every oversized inline file encoding. Reasoning files,
  nested tool-result files, and tagged/base64/data-URL payloads will be
  completed separately.

## 0.6.4

- Fix streaming UI message dedupe (#281)
- chore(deltas): delete legacy TextStreamPart streaming path (#275)
- fix(react): Fix O(n²) lag streaming long tool-input deltas (#190) (#270)
- fix(mapping): preserve tool messages in multi-step history (#200) (#272)
- fix: Stops a cleanup task from canceling itself (#285)

## 0.6.3

- Update types for `ctx` args to be more compatible with convex 1.41

## 0.6.2

- fix: persist final step when saveStreamDeltas.returnImmediately is true (#266)
- fix: handle tool validation errors in stopWhen and willContinue (#241)

## 0.6.1

- Fix bundled package

## 0.6.0

- Tool approval support: `needsApproval` in `createTool`,
  `agent.approveToolCall()`, `agent.denyToolCall()`
- Auto-deny unresolved tool approvals when a new generation starts
- Fix unhandled rejection in DeltaStreamer on transaction teardown

**Note on versioning:** This release jumps from 0.3.2 to 0.6.0, skipping
versions 0.4.0 and 0.5.0. This is intentional and aligns the `@convex-dev/agent`
package version with the AI SDK v6 major version for clearer compatibility
signaling. Going forward, the minor version of this package will track the AI
SDK major version to make it easier for developers to identify which version of
the AI SDK is supported.

- Breaking: Requires AI SDK v6 and drops support for AI SDK v5. Projects pinned
  to v5 must upgrade their AI SDK dependencies before updating to this version.
- Aligns this package's message and tool invocation types with the AI SDK v6
  APIs to reduce casting/adapter code when integrating with the core SDK.
- Updates internal helpers to use the AI SDK v6 request/response shapes and
  error handling semantics.
- Migration from 0.3.x:
  - Update your AI SDK dependency to v6 in `package.json` and reinstall
    dependencies.
  - Rebuild and run your type checker to surface any call sites that depend on
    the old AI SDK v5 types or message shapes.
  - Review any custom integrations that relied on deprecated v5-only helpers and
    update them to the new AI SDK v6-compatible APIs.
  - See Vercel's
    [v6 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0)
    for details on AI SDK changes.

## 0.3.2

- Fix deleteByOrder spanning many messages

## 0.3.1

- Avoid JSON.stringify in the render path for logging in useUIMessages.
- Ensures input messages are saved associated with promptMessageId. This
  generally happens by default, but if the promptMessageId wasn't latest, it
  would have previously saved them as the newest messages.

## 0.3.0

- Adds /test and /\_generated/component.js entrypoints
- Drops commonjs support
- Improves source mapping for generated files
- Changes to a statically generated component API

## 0.2.12

- Capture tool errors in the message

## 0.2.11

- Filters out empty content arrays when prompting the LLM.
- Fixes combining sequential user messages in useUIMessages
- Breaking: now joins all text parts with a space delimiter instead of strict
  concatenation. This improves text search and is unlikely to look worse, as
  text parts aren't meant to be deltas.
- Exports a `docsToModelMessages` to convert MessageDoc to ModelMessage taking
  into account omitting missing messages or empty content.
- Fixes playground UI showing follow-up messages.
- Adds a /test entrypoint to make adding tests with the agent easier.
- Simplifies the types for generating object & text to more closely match the AI
  SDK.
- Allows passing a `promptMessageId` to `saveMessage` to match `saveMessages`.

## 0.2.10

- Support models that return no content ([])
- Breaking bug fix: we were returning output in UIMessages with extra { type:
  "json", value: ... } instead of the value itself. Now we return the output
  directly.

## 0.2.9

- Add documentation for new behavior and export new functions.
- Deprecation: Renames deserializeMessage to toModelMessage.
- Fix: Pass provider metadata through more consistently in message parts.

## 0.2.8

- Adds useUIMessages and useUIStreamingMessages for UIMessage-first client
  usage. These have more metadata around reasoning streaming status, and provide
  support for metadata and custom data parts.
- Adds a `listUIMessages` akin to `listMessages` converted to UIMessages.
- Uses the UIMessageChunk stream when streaming text, which fixes many bugs
  which stemmed from the AI SDK's onChunk callback.
- Enables having streaming hooks skip streamIds so you can stream via HTTP for
  some clients and have others get the deltas.
- Compresses the deltas saved to the DB - combining text deltas & reasoning
  deltas that come from the same part `id`.
- `optimisticallySendMessage` will set fields for both MessageDoc and UIMessage,
  so it should transparently work for either hook strategy, though you may see
  more fields than you expect.
- Defaults `text` to `undefined` if it's empty (no text chunks)
- `mockModel` can now simulate responses for multi-step generation, by passing a
  `contentSteps` array to its constructor. Each element is an array of content
  for that step.
- `createTool` supports async iteration.
- Add `experimental_download` type to `generateObject`
- Adds `structuredClone` polyfill for ReactNative UIMessages.

## 0.2.7

- Updates types to match the latest `ai` package types - note: you should update
  the `ai` package to 5.0.29 or above.

## 0.2.6

- Splits out the `start` function from the Agent, along with other utilities
  that can be used without the Agent, e.g. to `saveInputMessages` and fetch
  context messages combined with input messages.
- Adds a `contextHandler` option to the Agent, which is a function to modify the
  context messages before they are passed to the LLM.
- Adds a `fromUIMessage` function to convert UIMessage[] to MessageDoc[].
- Fixes asObjectAction being generic on the wrong DataModel.
- Using `mockModel` works better now for streaming.
- Search text will use the last message, prompt, or promptMessage string.
- Fixes the `stepOrder` being off when streaming with tool calls.
- More readable MessageDoc type.
- The output of a tool result is now saved differently from the `result` and
  matches the ModelMessage expected format. This also coerces the previous
  `result` format into the new `output` data format.
- cachedInputTokens is now saved in the usage field
- The global default for providerOptions is supplied correctly, however lmk if
  you actually want it, otherwise it's deprecated and may be removed.
- Fix: useSmoothText starts streaming even if no text update happens.
- The DeltaStreamer class is now generic on the type of part to save, and
  decoupled to make it easier to use on its own.
- Running agent-playground works on windows (credit: yahyasamet)
- The setup script works interactively (credit: kfiroo)
- Playground assistant messages CSS fix (credit: jamieday)
- Fix: promptMessageId is back on the generate/streamObject args type

## 0.2.5

- omit fileIds in saveMessages when none present (credit:mlshv)
- Add source as a first-class content type for assistants (unstable)
- Adds a `mockModel` utility for testing (that works in the default Convex
  runtime).
- Fixes async abort saving of messages.
- No longer saves the final delta when aborting a stream async.

## 0.2.4

- No longer fails previous messages by default when generating without a
  promptMessageId
- Fixes double-submitting the user prompt when using promptMessageId

## 0.2.3

- Reintroduces the `maxSteps` config for Agents / global config. This becomes
  the default when `stopWhen` is not provided.
- Supports a tool response in an assistant message
- Correctly handles providerOptions vs. providerMetadata in ser/de
- Fix up reasoning state (breaking but shouldn't be present anywhere)
- You can now pass `args` directly to `listMessages` instead of passing threadId
  & paginationOpts manually.
- useSmoothText is even smoother
- toUIMessage is much better - works in both directions with any ordering
- Only embeds the first 10k of characters for vector search.

## 0.2.2

- Add \_creationTime to UIMessage (number) to replace v4's createdAt
- Improves the playground debugging by enabling streaming
- Fixes .text in UIMessages when `text` wasn't set already
- Fixes skipping failed agent tool calls in toUIMessages
- Assume no stop when means only one step

## 0.2.1

- Defaults to consuming the stream when saving deltas, so you don't have to do
  `result.consumeStream()`. You can pass `returnImmediately: true` if you want
  to save deltas and also process the stream yourself.
- Agent name is now required.
- You can specify default `providerOption`s at the Agent level.
- The `agent` param in `ToolCtx` is now optional to make it easier to manually
  wrap tools before the agent is defined.

## 0.2.0 AI SDK v5 support

Adds support for the AI SDK v5, and associated versions of LLM providers. This
involves some breaking changes associated with the changes to the UI, but the
data at rest is backwards compatible.

- Supports LanguageModel: a string for gateway or LanguageModelV2.
- No longer returns lastMessageId when saving message, instead it returns all
  the messages it saved with all metadata.
- All saved messages are returned when generating / streaming text / objects.
  Not just the prompt message ID / order.
- Adds a `SmoothText` component that can be used to render streaming text.
- Generating / streaming will return a `promptMessageId` field, which is the
  message ID of the last message that was used as the prompt. This replaces the
  `messageId` field, which was confusing.
- There's a `.start` function you can use to call the AI SDK directly and still
  get all the message management benefits.
- More functions are supported without using an Agent class.
- The UIMessage is now based on the v5 UIMessage, and the MessageDoc is based on
  the ModelMessage. The data at rest has not changed - backwards compatible.
- Add a `.text` field to the toUIMessages return value (this is the UIMessage
  exported by the Agent library) to replace the `content` field.
- The `id` is no longer used / configurable when saving messages. Reach out if
  you were using it - the normal message ID should suffice.
- `maxRetries` option has been moved into a general `callSettings` config on
  Agent, and in general has been renamed to `stopWhen` in v5.
- Saving pending messages now requires passing status: "pending" instead of a
  top-level pending: true. Most people don't use this feature currently.
- A pending message is now created by default when generating / streaming text /
  objects, representing the message that is being generated. It will attempt to
  only create pending messages when it anticipates generating a response.
- On failure / abort, the pending message is updated with streaming contents.
- Breaking: the `thread` return value from `continueThread` no longer allows
  overriding the tools or usage handler at the thread level. You can still
  override the agent defaults at the call-site.

## 0.1.18

- definePlaygroundAPI uses the new interface functions
- Add generic types on UIMessages (credit: ethan-huo)
- Deleting returns the order range (credit: ethan-huo)
- Allow specifying a custom `ctx` type for use in tools created with
  `createTool`
- Fix resolution of `definePlaygroundApi`
- Fix: ReactNative can do optimistic updates even if it has crypto defined
- Fix: getMessageByIds correctly serializes non-user messages
- Fix: usage handler won't be overwritten with undefined.

## 0.1.17

- Importing `definePlaygroundAPI` from @convex-dev/agent directly
- Supports adding a file to the message history from an httpAction
- Fix: enforce storageOptions "none" in streamText (credit: fvaldes33)

## 0.1.16

- It's possible to call many agent functions directly from a workflow.
- Support calling generate/stream with the same `promptMessageId` multiple times
  and have it continue the generation, e.g. when maxSteps is 1.
- `asTextAction` and `asObjectAction` now return `order` and `warnings`.
- generating embeddings asynchronously is more efficient
- Deprecated: dropped long-deprecated args like `isTool`, and some
  `storageOptions.save*` options that have been replaced with alternatives.
- Breaking: `.id` on `toUIMessages` is now always the message's `_id`, not any
  custom id provided from the AI SDK. Shouldn't affect ~anyone.
- Fix embedding/vector argument to search messages
- Fix handling of `undefined` in streaming text
- Return the last agent name to the playground UI
- Validate the playground backend less frantically
- Allow passing null for userId arguments

## 0.1.15

- Agents can be dynamically created for the playground
- You can abort streaming messages by ID or message `order`
- You can request that `syncStreams` return aborted streamed messages, if you
  want to show those in your UI.
- They will have `msg.streaming === false` if they were aborted.
- Factored out functions so you don't have to have an agent to call:
  `saveMessages`, `getThreadMetadata`, `createThread`, `fetchContextMessages`,
  `listMessages`, `syncStreams`
- Improved the `ctx` type for the raw request handler and exposed more types
- Add `agentName` to `UIMessage`
- Saving messages returns the `order` of the last message saved.
- Fix: stream deletion is idempotent and cleanup is canceled if it's already
  deleted.

## 0.1.14

- Show reasoning before text in UI messages
- List un-named agents in the playground
- Expose delete functions for messages & threads on the Agent class
- Expose updating messages on the Agent class
- Expose the types for ThreadQuery, StreamArgs, and SyncStreamsReturnValue
- Fix thread title text search
- Fix loading state of pagination (peer bump)
- Fix user messages going from pending-> failed when using prompt with
  generateText repeatedly in a thread.

## 0.1.13

- Allow updating a thread's userId
- Auth is available in the `createTool` ctx.
- Add text search on thread titles.
- Add RAG example & docs

## 0.1.12

- Pass the final model & provider when storing messages, in case it was
  overriden at the thread/callsite level.

## 0.1.11

- Supports passing both a promptMessageId and messages, so you can pass context
  messages while also generating the propt message ahead of time in a mutation.
- Now includes an example of RAG using the Memory component.

## 0.1.10

- Fix object serialization
- Sources will be populated to non-tool results
- Deleting files will return the files actually deleted
- Agents without names will warn if used in the playground
- More graceful deletion of streams

## 0.1.9

- You can abort a stream asynchronously and have it stop writing deltas
  smoothly.
- The timeout for streaming deltas with no sign of life has been increased to 10
  minutes.
- Delete stream deltas automatically 5 min after the stream finishes.
- Fix: deleting threads asynchronously will clean up deltas.
- Fix: update the reasoning in the top-level message when streaming

## 0.1.8

- Support images in localhost by loading them locally and passing them to the
  LLM as raw data. (author: @julionav)
- Add `updateMessage` to the raw components.agent.messages API for patching
  existing message contents, status, and error details. (author: @julionav)
- Add extensions to support NodeNext bundling
- Fix: paginating over all users now works for more than one page
- Fix: streams are now deleted when deleting threads / user data

## 0.1.7

- Image and file handling! It now auto-saves large input messages, and has an
  API to save and get metadata about files, as well as automatic reference
  counting for files being used in messages, so you can vacuum unused files.
  Check out [examples/files-images](./example/convex/files), which also includes
  an example generating an image and saving it in messages one-shot.
- Adds a `rawRequestResponseHandler` argument to the Agent that is a good spot
  to log or save all raw request/responses if you're trying to debug model
  behavior, headers, etc.
- Centralizes the example model usage so you can swap models in one place.
- StorageOptions now takes a better argument name
  `saveMessages?: "all" | "none" | "promptAndOutput";`, deprecating
  `save{All,Any}InputMessages` and `saveOutputMessages`.
- Add `rawRequestResponseHandler` to the Agent definition, so you can log the
  raw request and response from the LLM.

### Deprecated

- The `files` field is deprecated in favor of `fileIds` in the message metadata.
  This wasn't really used before but it was possible folks discovered how to set
  it.

### Breaking

- The `steps` table is now gone. It will still be around in your backend, where
  you can inspect or clear it if you want, but it will not be written to, and
  the low-level APIs around saving steps alongside messages are gone. To get
  debug information, you can use the `rawRequestResponseHandler` and dump the
  request and response to your own debug table. Maybe conditional on some
  environment variable so you can turn it on/off for debugging.

## 0.1.6

- Fix pagination for the Agent messages when loading more
- Allow using useSmoothText in Next.js
- Fix: re-export `ToolCtx` in `@convex-dev/agent/react`

## 0.1.5

- APIs to get and update thread metadata on the agent / thread objects.
- Support generating embeddings asynchronously to save messages in mutations.
- Allow embedding generation to be done lazily by default.
- Build the project so it's compatible with composite and verbatim module syntax
- `useSmoothText` is even smoother
- Fix handling of file messages to include `filename` and `data` field instead
  of `file`.
- Fix bundling of api.d.ts to fix the `AgentComponent` type being `any`.
- More examples in the examples/ directory, that you can access from the root
  example
- Improve scripts for running the examples. See README.
- Starting to unify model definitions for examples so you only have to change it
  in one place to e.g. use grok.
- Better import hygiene for folks using `verbatimModuleSyntax`.

## 0.1.4

- Automatically pulls in the thread's userId when no userId is specified.
- Fixes bugs around duplicate content when streaming / using toUIMessages.
- `useSmoothText` is now even smoother with a stream rate that auto-adjusts.
- Defaults streaming chunks to sentence instead of word.

### Breaking

- The `userId` associated with the thread will automatically be associated with
  messages and tool calls, if no userId is passed at thread continuation or
  call-site. This is likely what you want, but in case you didn't, consider not
  setting a default userId for the thread and passing it in only when continuing
  the thread.
- The `searchMessage` and `textSearch` functions now take the more explicit
  parameter `searchAllMessagesForUserId` instead of `userId`.

## 0.1.3

- Allows you to pass `promptMessageId` to `agent.streamText`. This parameter
  allows you to create a message ahead of time and then generate the response
  separately, responding to that message.

## 0.1.2

- Added text delta streaming with `useThreadMessages` and
  `useStreamingThreadMessages` React hooks. See examples/chat-streaming for
  example usage.
- Also includes a `useSmoothText` hook and `optimisticallySendMessage` to get
  smooth streaming UI and immediate feedback when a user sends a msg.
- Adds a UIMessage type that is an AI SDK UIMessage with some extra fields for
  convenience, e.g. a stable key, order/stepOrder, streaming status.
- Allow listing threads without an associated userId in the playground.
- make stepOrder always increasing, for more predictable sorting of failed +
  non-failed messages.
- A reference to the agent is now passed to tool calls using the `createTool`
  utility.
- In more places, we aren't storing the AI SDK `id` unless explicitly passed in,
  and favoring the built-in Convex ID instead.
- The examples/ folder will become a better resource with more specific
  examples. For now, there's an index page when running the examples, that
  points to the text streaming and weather demos.
- There's now `listMessages` `saveMessage`, and `asSaveMessagesMutation` on the
  Agent. `listMessages` is compliant with the normal pagination API.

### Breaking

- `components.agent.messages.listMessagesByThreadId` is now `asc`ending by
  default! It'll have a type error to help you out. While you're at it, you can
  use the new `.listMessages` on the agent itself!
- `addStep` now returns the messages it created instead of a step. This is not
  likely to be called by clients directly. It's mostly used internally.
- `toUIMessages` has been moved to the `@convex-dev/agent/react` import
  entrypoint.

## 0.1.1

- The file api has been improved to allow for upserting files more correctly.
  You can use it to track images and files in messages, and have a cron that
  queries for images that can be safely deleted. When adding it to a message,
  call `addFile`, `useExistingFile`, or `copyFile` to get the `fileId` and add
  it to the message metadata. When the message is deleted, it will delete the
  file (if it has the last reference to it).
- Added an example for passing in images to LLMs.
- Embeddings of length 1408 are now supported.

## 0.1.0

- UI Playground, to host locally or embed into your app.
  - On the left panel it has a dropdown to select a users, then lists the user's
    treads
  - In the middle you can see the thread's messages and tool calls, as well as
    send new messages in the thread:
    - Configurable context & message saving options
    - Play with the system prompt for rapid prototyping.
  - On the right you can see the selected message's details, as well as fetch
    contextual messages to investigate what messages would get fetched for that
    message, with configurable ContextOptions.
  - Use the [hosted version](https://convex.github.io/agent/) or run it
    locally with `npx @convex-dev/agent-playground` - uses Vite internally for
    now.
  - API key management (to authenticate into the UI Playground)
- The `order` and `stepOrder` is now well defined: each call to something like
  `generateText` will be on the next "order" and each message generated from it
  will have increasing "subOrder" indexes.
- Adds a function to turn MessageDoc[] into UIMessage[].
- Eliminates an index to reduce storage cost per-message.
- The README is a better resource.

### Breaking

- `agent.fetchContextMessages` now returns `MessageDoc` instead of a
  `CoreMessage` objects.
- `isTool` configuration for context has been changed to `excludeToolMessages` -
  where `false`/`undefined` is the default and includes tool messages, and
  `true` will only return user/assistant messages.
- Reorganization of API (split `agent.messages.*` into `agent.threads.*`,
  `agent.messages.*`, `agent.files.*`, and `agent.users.*`.
- Parameters like `parentMessageId` have generally been renamed to
  `promptMessageId` or `beforeMessageId` or `upToAndIncludingMessageId` to
  better clarify their use for things like using an existing message as a prompt
  or searching context from before a message, or fetching messages up to and
  including a given message. The `generate*` / `stream*` functions can take a
  `promptMessageId` instead of a `prompt` / `messages` arg now.
- Calls to steps and objects now take a parentMessageId instead of messageId
  parameter, as this is the true meaning of parent message (the message being
  responded to).

### Deprecated

- The `steps` table is going away, to be replaced with a callback where you can
  dump your own comprehensive debug information if/when you want to. As such,
  the `stepId` field isn't returned on messages.
- The `parentMessageId` field is no longer exposed. Its purpose is now filled by
  the order & stepOrder fields: each message with the same order is a child of
  the message at stepOrder 0.

## 0.0.16

- Fixes a bug with providing out-of-order tool messages in the prompt context.
  (author: @apostolisCodpal)

## 0.0.15

- You can pass tools at the agent definition, thread definition, or per-message
  call, making it easier to define tools at runtime with runtime context.

- README improvements

### Breaking Changes

- `getEmbeddings` has been renamed to `generateEmbeddings`

### Deprecated

- Passing `ConfigOptions` and `StorageOptions` should now be passed as separate
  parameters via `configOptions` and `storageOptions`. e.g. for `generateText`
  `{ prompt }, { contextOptions: { recentMessages: 10 } }` instead of
  `{ prompt, recentMessages: 10 }`

## 0.0.14

- There is now a usageHandler you can specify on the Agent definition, thread,
  or per-message that can log or save token usage history.

- The model and provider are being stored on the messages table, along with
  usage, warnings, and other fields previously hidden away in the steps table.

### Bug fixes

- The agent name is now correctly propagating to the messages table for non-user
  messages.

### Deprecated

- parentThreadIds is deprecated, as it wasn't merging histories and the desire
  to do so should have a message as its parent to make the history behavior
  clear.
