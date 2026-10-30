# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

@convex-dev/agent is a TypeScript/NPM package that provides an AI Agent component for Convex. It enables building agentic AI applications with thread/message management, LLM integration via AI SDK, WebSocket streaming, tool calling, vector embeddings, and RAG.

Documentation: [Convex Agent Docs](https://docs.convex.dev/agents)

## Commands

### Development
```bash
npm run dev          # Run backend + frontend + build watch concurrently
npm run build        # TypeScript build (tsc --project ./tsconfig.build.json)
```

### Testing
```bash
npm test             # Run tests with typecheck (vitest run --typecheck)
npm run test:watch   # Watch mode (vitest --typecheck)
```

### Code Quality
```bash
npm run lint         # ESLint
npm run typecheck    # Full TypeScript validation including example/convex
```

## Architecture

### Source Structure (`/src`)

**Three-Layer Architecture:**
1. **Client** (`src/client/`) - Public API for consuming applications
   - `index.ts` - Main `Agent` class and exports
   - `start.ts` - `startGeneration()` core generation logic
   - `streaming.ts`, `search.ts`, `messages.ts`, `threads.ts` - Feature modules

2. **Component** (`src/component/`) - Convex backend (runs on Convex servers)
   - `schema.ts` - Database schema (threads, messages, streamingMessages, streamDeltas, files)
   - `index.ts` - Main component implementation
   - Backend operations for messages, threads, streaming, vector search

3. **React** (`src/react/`) - React hooks for UI integration
   - `useThreadMessages.ts` - Paginated + streaming messages
   - `useUIMessages.ts` - UIMessage-first hook with metadata
   - `useSmoothText.ts` - Animated text rendering

**Shared Files:**
- `validators.ts` - Convex validators (vMessage, vMessageDoc, vThreadDoc, etc.)
- `UIMessages.ts` - UIMessage types and conversion utilities
- `mapping.ts` - Message serialization between ModelMessage and stored formats

### Key Patterns

- **Streaming via WebSocket deltas** - Not HTTP streaming. Delta compression with heartbeats.
- **Message-centric design** - All operations revolve around message persistence/retrieval
- **Component-based encapsulation** - Uses Convex Components pattern
- **Multi-user support** - Threads have optional `userId` for ownership
- **Tool approval flow** - Tools can require human approval via `needsApproval`, with `agent.approveToolCall()` and `agent.denyToolCall()` methods

### Database Tables (Convex Component)

- **threads** - Conversations with userId, title, summary, status
- **messages** - Chat messages with order, stepOrder, status, metadata
- **streamingMessages** - Real-time streaming state (streaming/finished/aborted)
- **streamDeltas** - Stream chunks with start/end ranges

## Convex-Specific Guidelines

Follow the rules in `.cursor/rules/convex_rules.mdc`:

- **Function syntax**: Always use new syntax with `args` and `returns` validators
- **Validators**: Use `v.null()` for null returns, `v.int64()` instead of deprecated `v.bigint()`
- **Indexes**: Include all fields in index name (e.g., `by_threadId_and_status`)
- **Queries**: Use `withIndex` instead of `filter`; define indexes in schema
- **Internal functions**: Use `internalQuery`/`internalMutation`/`internalAction` for private functions
- **Actions**: Add `"use node";` for Node.js modules; actions cannot use `ctx.db`
- **Type safety**: Use `Id<'tableName'>` for document IDs, strict TypeScript

## Export Surfaces

- `@convex-dev/agent` - Main exports (Agent class, types, validators, tools)
- `@convex-dev/agent/react` - React hooks (useThreadMessages, useUIMessages, etc.)
- `@convex-dev/agent/validators` - Convex validators for integration
- `@convex-dev/agent/test` - Testing utilities

## AI Guidance: Helping Users Upgrade

**IMPORTANT: v0.7 requires AI SDK v7 (ai@^7.0.0) and Node.js 22 or newer.** For v0.6.x to v0.7, follow `MIGRATION.md`.

```bash
npm install @convex-dev/agent@^0.7.0 ai@^7.0.0 @ai-sdk/provider@^4.0.0 @ai-sdk/provider-utils@^5.0.0
npm install @ai-sdk/openai@^4.0.0  # or whichever provider
```

`@convex-dev/rag` needs 0.7.6 or newer, the first release on AI SDK 7.

### Historical: v0.3.x (AI SDK v5) to v0.6.0 (AI SDK v6)

The remaining sections describe the older v5 to v6 upgrade. Apply them first when a project is still on v0.3.x, then continue with `MIGRATION.md`.

#### Step 2: Detect v5 Patterns

Search for these patterns indicating v5 usage:
- `createTool({ args:` - should be `inputSchema`
- `createTool({ handler:` - should be `execute`
- `textEmbeddingModel:` - should be `embeddingModel`
- `maxSteps:` in generateText/streamText - should be `stopWhen: stepCountIs(N)`
- `mode: "json"` in generateObject - removed in v6
- `@ai-sdk/*` packages at v1.x or v2.x - should be v3.x
- Type imports: `LanguageModelV2` → `LanguageModelV3`, `EmbeddingModel<string>` → `EmbeddingModelV3`

#### Step 3: Apply Transformations

**Tool definitions:**
```typescript
// BEFORE (v5)
const myTool = createTool({
  description: "...",
  args: z.object({ query: z.string() }),
  handler: async (ctx, args) => {
    return args.query.toUpperCase();
  }
})

// AFTER (v6)
const myTool = createTool({
  description: "...",
  inputSchema: z.object({ query: z.string() }),
  execute: async (ctx, input, options) => {
    return input.query.toUpperCase();
  }
})
```

**Agent embedding config:**
```typescript
// BEFORE
new Agent(components.agent, {
  textEmbeddingModel: openai.embedding("text-embedding-3-small")
})

// AFTER
new Agent(components.agent, {
  embeddingModel: openai.embedding("text-embedding-3-small")
})
```

**Step limits:**
```typescript
// BEFORE
await agent.generateText(ctx, { threadId }, {
  prompt: "...",
  maxSteps: 5
})

// AFTER
import { stepCountIs } from "@convex-dev/agent"
await agent.generateText(ctx, { threadId }, {
  prompt: "...",
  stopWhen: stepCountIs(5)
})
```

**Type imports:**
```typescript
// BEFORE (v5)
import type { LanguageModelV2 } from "@ai-sdk/provider";
import type { EmbeddingModel } from "ai";
let model: LanguageModelV2;
let embedder: EmbeddingModel<string>;

// AFTER (v6)
import type { LanguageModelV3, EmbeddingModelV3 } from "@ai-sdk/provider";
let model: LanguageModelV3;
let embedder: EmbeddingModelV3;
```

**generateObject (remove mode: "json"):**
```typescript
// BEFORE (v5)
await generateObject({
  model,
  mode: "json",
  schema: z.object({ ... }),
  prompt: "..."
})

// AFTER (v6) - mode: "json" removed, just use schema
await generateObject({
  model,
  schema: z.object({ ... }),
  prompt: "..."
})
```

#### Step 4: Verify

```bash
npm run typecheck
npm test
```

#### Common Issues

- **EmbeddingModelV2 vs V3 errors**: Ensure all `@ai-sdk/*` packages are v3.x
- **Tool `args` vs `input`**: v6 uses `input` in execute signature (2nd param)
- **`mimeType` vs `mediaType`**: v6 prefers `mediaType` (backwards compat maintained)
- **Type import errors**: `LanguageModelV2` is now `LanguageModelV3`, `EmbeddingModel<string>` is now `EmbeddingModelV3` (no longer generic)
- **generateObject mode errors**: `mode: "json"` was removed in v6 - just remove the mode option

#### New v6 Features to Mention

After upgrade, users can now use:
- **Tool approval**: `needsApproval` in createTool, `agent.approveToolCall()`, `agent.denyToolCall()`
- **Reasoning streaming**: Works with models like Groq that support reasoning
- **Detailed token usage**: `inputTokenDetails`, `outputTokenDetails` in usage tracking
