// See the docs at https://docs.convex.dev/agents/batch
import type {
  Experimental_BatchV4 as BatchApi,
  LanguageModelV4,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import {
  experimental_getBatchStatus as getBatchStatus,
  experimental_startBatch as startBatch,
  type Experimental_TextBatchRequest as TextBatchRequest,
} from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { v } from "convex/values";
import { Agent } from "@convex-dev/agent";
import { components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  type ActionCtx,
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { defaultConfig } from "../agents/config";

export const batchAgent = new Agent(components.agent, {
  name: "Batch Agent",
  instructions: "You are a concise assistant.",
  ...defaultConfig,
});

function batchApiFor(model: LanguageModelV4): BatchApi {
  if (model.provider.startsWith("openai")) return openai.experimental_batch();
  if (model.provider.startsWith("anthropic")) {
    return anthropic.experimental_batch();
  }
  throw new Error(`No batch API for ${model.provider}`);
}

function languageModelOf(agent: Agent): LanguageModelV4 {
  const model = agent.options.languageModel;
  if (typeof model !== "object" || model.specificationVersion !== "v4") {
    throw new Error("Batching needs a LanguageModelV4 instance");
  }
  return model;
}

/**
 * Builds each thread's context exactly as a normal generation would, and
 * submits one batch request per prompt message. The prompts must already be
 * saved, e.g. with `saveMessage` in the mutation that queues the work.
 */
export async function startThreadBatch(
  ctx: ActionCtx,
  agent: Agent,
  batchApi: BatchApi,
  items: { threadId: string; promptMessageId: string }[],
  webhookUrl?: (batchId: Id<"batches">, token: string) => string,
) {
  const model = languageModelOf(agent);
  const requests = await Promise.all(
    items.map(async ({ threadId, promptMessageId }) => {
      const { args } = await agent.start(
        ctx,
        { promptMessageId },
        { threadId, storageOptions: { saveMessages: "none" } },
      );
      const {
        model: _model,
        runtimeContext: _runtimeContext,
        abortSignal: _abortSignal,
        ...callArgs
      } = args;
      return {
        ...callArgs,
        id: promptMessageId,
        type: "text",
        model: model.modelId,
      } as TextBatchRequest;
    }),
  );
  const { batchId, webhookToken } = await ctx.runMutation(
    internal.batch.batch.createBatch,
    { items },
  );
  const batch = await startBatch({
    provider: batchApi,
    requests,
    webhookUrl: webhookUrl?.(batchId, webhookToken),
  });
  await ctx.runMutation(internal.batch.batch.setBatchReference, {
    batchId,
    batch: { version: batch.version, id: batch.id, provider: batch.provider },
  });
  return batchId;
}

/**
 * A model that answers the first call with the batch's result and defers to
 * the real model after that. Passing it to `agent.generateText` saves the
 * result through the normal path: the stored message shape, usage reporting,
 * embeddings, and tool execution plus any follow-up steps.
 */
function replayModel(
  result: LanguageModelV4GenerateResult,
  model: LanguageModelV4,
): LanguageModelV4 {
  let replayed = false;
  return {
    specificationVersion: "v4",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: async (options) => {
      if (replayed) return model.doGenerate(options);
      replayed = true;
      return result;
    },
    doStream: (options) => model.doStream(options),
  };
}

/**
 * Saves every finished result into its thread. Safe to call repeatedly: each
 * item is claimed once, so a duplicate webhook or an overlapping poll is a
 * no-op. Claiming before saving is at-most-once on purpose: retrying a result
 * whose save was cut short could save a second answer and rerun its tools.
 */
export async function saveBatchResults(
  ctx: ActionCtx,
  agent: Agent,
  batchApi: BatchApi,
  batchId: Id<"batches">,
): Promise<"pending" | "done"> {
  const doc = await ctx.runQuery(internal.batch.batch.getBatch, { batchId });
  if (!doc?.batch) return "pending";
  if (doc.status === "done") return "done";
  const { status } = await getBatchStatus({
    provider: batchApi,
    batch: doc.batch,
  });
  if (status === "pending") return "pending";

  const model = languageModelOf(agent);
  const results = await batchApi.doGetBatchResults({
    batchId: doc.batch.id,
  });
  for await (const item of results) {
    if (item.type !== "text") continue;
    const claimed = await ctx.runMutation(internal.batch.batch.claimItem, {
      batchId,
      promptMessageId: item.id,
    });
    if (!claimed) continue;
    if (item.status === "succeeded") {
      await agent
        .generateText(
          ctx,
          { threadId: claimed.threadId },
          {
            promptMessageId: item.id,
            model: replayModel(item.result, model),
          },
        )
        // generateText already marked its message failed.
        .catch((error) => console.error("Saving batch result", error));
    } else {
      await saveFailure(
        ctx,
        agent,
        claimed.threadId,
        item.id,
        item.error?.message ?? item.status,
      );
    }
  }
  for (;;) {
    const { missing, done } = await ctx.runMutation(
      internal.batch.batch.finishBatch,
      { batchId },
    );
    for (const { threadId, promptMessageId } of missing) {
      await saveFailure(
        ctx,
        agent,
        threadId,
        promptMessageId,
        "Missing from batch results",
      );
    }
    if (done) return "done";
  }
}

async function saveFailure(
  ctx: ActionCtx,
  agent: Agent,
  threadId: string,
  promptMessageId: string,
  error: string,
) {
  await agent.saveMessage(ctx, {
    threadId,
    promptMessageId,
    message: { role: "assistant", content: [] },
    metadata: { status: "failed", error },
  });
}

export const startBatchForThreads = internalAction({
  args: {
    items: v.array(
      v.object({ threadId: v.string(), promptMessageId: v.string() }),
    ),
  },
  returns: v.id("batches"),
  handler: async (ctx, { items }): Promise<Id<"batches">> => {
    const batchApi = batchApiFor(languageModelOf(batchAgent));
    const batchId = await startThreadBatch(ctx, batchAgent, batchApi, items);
    await ctx.scheduler.runAfter(60_000, internal.batch.batch.pollBatch, {
      batchId,
    });
    return batchId;
  },
});

export const pollBatch = internalAction({
  args: { batchId: v.id("batches") },
  returns: v.null(),
  handler: async (ctx, { batchId }) => {
    // Scheduled first so a failed poll still leaves the next one queued.
    const next = await ctx.scheduler.runAfter(
      60_000,
      internal.batch.batch.pollBatch,
      { batchId },
    );
    const batchApi = batchApiFor(languageModelOf(batchAgent));
    const result = await saveBatchResults(ctx, batchAgent, batchApi, batchId);
    if (result === "done") await ctx.scheduler.cancel(next);
    return null;
  },
});

// For providers that notify a webhookUrl. The body is not trusted: the
// request only triggers a poll, which asks the provider for the real status.
export const batchWebhook = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const batchId = url.searchParams.get("batchId");
  const token = url.searchParams.get("token");
  if (!batchId || !token) return new Response(null, { status: 400 });
  const ok = await ctx.runMutation(internal.batch.batch.pollFromWebhook, {
    batchId,
    token,
  });
  return new Response(null, { status: ok ? 200 : 404 });
});

export const pollFromWebhook = internalMutation({
  args: { batchId: v.string(), token: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { batchId, token }) => {
    const id = ctx.db.normalizeId("batches", batchId);
    const doc = id && (await ctx.db.get("batches", id));
    if (!doc || doc.webhookToken !== token) return false;
    await ctx.scheduler.runAfter(0, internal.batch.batch.pollBatch, {
      batchId: doc._id,
    });
    return true;
  },
});

export const createBatch = internalMutation({
  args: {
    items: v.array(
      v.object({ threadId: v.string(), promptMessageId: v.string() }),
    ),
  },
  returns: v.object({ batchId: v.id("batches"), webhookToken: v.string() }),
  handler: async (ctx, { items }) => {
    const webhookToken = crypto.randomUUID();
    const batchId = await ctx.db.insert("batches", {
      status: "pending",
      webhookToken,
    });
    for (const item of items) {
      await ctx.db.insert("batchItems", {
        batchId,
        ...item,
        status: "pending",
      });
    }
    return { batchId, webhookToken };
  },
});

const vBatchReference = v.object({
  version: v.literal(2),
  id: v.string(),
  provider: v.string(),
});

export const setBatchReference = internalMutation({
  args: { batchId: v.id("batches"), batch: vBatchReference },
  returns: v.null(),
  handler: async (ctx, { batchId, batch }) => {
    await ctx.db.patch("batches", batchId, { batch });
    return null;
  },
});

export const getBatch = internalQuery({
  args: { batchId: v.id("batches") },
  returns: v.union(
    v.null(),
    v.object({
      batch: v.optional(vBatchReference),
      status: v.union(v.literal("pending"), v.literal("done")),
    }),
  ),
  handler: async (ctx, { batchId }) => {
    const doc = await ctx.db.get("batches", batchId);
    return doc && { batch: doc.batch, status: doc.status };
  },
});

export const claimItem = internalMutation({
  args: { batchId: v.id("batches"), promptMessageId: v.string() },
  returns: v.union(v.null(), v.object({ threadId: v.string() })),
  handler: async (ctx, { batchId, promptMessageId }) => {
    const item = await ctx.db
      .query("batchItems")
      .withIndex("batchId_promptMessageId", (q) =>
        q.eq("batchId", batchId).eq("promptMessageId", promptMessageId),
      )
      .unique();
    if (!item || item.status === "done") return null;
    await ctx.db.patch("batchItems", item._id, { status: "done" });
    return { threadId: item.threadId };
  },
});

export const finishBatch = internalMutation({
  args: { batchId: v.id("batches") },
  returns: v.object({
    missing: v.array(
      v.object({ threadId: v.string(), promptMessageId: v.string() }),
    ),
    done: v.boolean(),
  }),
  handler: async (ctx, { batchId }) => {
    const missing = await ctx.db
      .query("batchItems")
      .withIndex("batchId_status", (q) =>
        q.eq("batchId", batchId).eq("status", "pending"),
      )
      .take(100);
    for (const item of missing) {
      await ctx.db.patch("batchItems", item._id, { status: "done" });
    }
    const done = missing.length < 100;
    if (done) await ctx.db.patch("batches", batchId, { status: "done" });
    return {
      missing: missing.map(({ threadId, promptMessageId }) => ({
        threadId,
        promptMessageId,
      })),
      done,
    };
  },
});
