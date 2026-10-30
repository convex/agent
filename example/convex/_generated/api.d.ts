/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents_approval from "../agents/approval.js";
import type * as agents_config from "../agents/config.js";
import type * as agents_fashion from "../agents/fashion.js";
import type * as agents_simple from "../agents/simple.js";
import type * as agents_story from "../agents/story.js";
import type * as agents_weather from "../agents/weather.js";
import type * as batch_batch from "../batch/batch.js";
import type * as batch_tables from "../batch/tables.js";
import type * as chat_approval from "../chat/approval.js";
import type * as chat_basic from "../chat/basic.js";
import type * as chat_human from "../chat/human.js";
import type * as chat_streamAbort from "../chat/streamAbort.js";
import type * as chat_streaming from "../chat/streaming.js";
import type * as chat_streamingReasoning from "../chat/streamingReasoning.js";
import type * as chat_withoutAgent from "../chat/withoutAgent.js";
import type * as crons from "../crons.js";
import type * as debugging_rawRequestResponseHandler from "../debugging/rawRequestResponseHandler.js";
import type * as debugging_telemetry from "../debugging/telemetry.js";
import type * as files_addFile from "../files/addFile.js";
import type * as files_autoSave from "../files/autoSave.js";
import type * as files_generateImage from "../files/generateImage.js";
import type * as files_vacuum from "../files/vacuum.js";
import type * as http from "../http.js";
import type * as modelsForDemo from "../modelsForDemo.js";
import type * as objects_generateObject from "../objects/generateObject.js";
import type * as objects_streamArray from "../objects/streamArray.js";
import type * as playground from "../playground.js";
import type * as rag_ragAsPrompt from "../rag/ragAsPrompt.js";
import type * as rag_ragAsTools from "../rag/ragAsTools.js";
import type * as rag_tables from "../rag/tables.js";
import type * as rag_utils from "../rag/utils.js";
import type * as rate_limiting_rateLimiting from "../rate_limiting/rateLimiting.js";
import type * as rate_limiting_tables from "../rate_limiting/tables.js";
import type * as rate_limiting_utils from "../rate_limiting/utils.js";
import type * as threads from "../threads.js";
import type * as tools_agentAsTool from "../tools/agentAsTool.js";
import type * as tools_searchMessages from "../tools/searchMessages.js";
import type * as tools_updateThreadTitle from "../tools/updateThreadTitle.js";
import type * as tools_weather from "../tools/weather.js";
import type * as usage_tracking_invoicing from "../usage_tracking/invoicing.js";
import type * as usage_tracking_tables from "../usage_tracking/tables.js";
import type * as usage_tracking_usageHandler from "../usage_tracking/usageHandler.js";
import type * as utils from "../utils.js";
import type * as workflows_chaining from "../workflows/chaining.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "agents/approval": typeof agents_approval;
  "agents/config": typeof agents_config;
  "agents/fashion": typeof agents_fashion;
  "agents/simple": typeof agents_simple;
  "agents/story": typeof agents_story;
  "agents/weather": typeof agents_weather;
  "batch/batch": typeof batch_batch;
  "batch/tables": typeof batch_tables;
  "chat/approval": typeof chat_approval;
  "chat/basic": typeof chat_basic;
  "chat/human": typeof chat_human;
  "chat/streamAbort": typeof chat_streamAbort;
  "chat/streaming": typeof chat_streaming;
  "chat/streamingReasoning": typeof chat_streamingReasoning;
  "chat/withoutAgent": typeof chat_withoutAgent;
  crons: typeof crons;
  "debugging/rawRequestResponseHandler": typeof debugging_rawRequestResponseHandler;
  "debugging/telemetry": typeof debugging_telemetry;
  "files/addFile": typeof files_addFile;
  "files/autoSave": typeof files_autoSave;
  "files/generateImage": typeof files_generateImage;
  "files/vacuum": typeof files_vacuum;
  http: typeof http;
  modelsForDemo: typeof modelsForDemo;
  "objects/generateObject": typeof objects_generateObject;
  "objects/streamArray": typeof objects_streamArray;
  playground: typeof playground;
  "rag/ragAsPrompt": typeof rag_ragAsPrompt;
  "rag/ragAsTools": typeof rag_ragAsTools;
  "rag/tables": typeof rag_tables;
  "rag/utils": typeof rag_utils;
  "rate_limiting/rateLimiting": typeof rate_limiting_rateLimiting;
  "rate_limiting/tables": typeof rate_limiting_tables;
  "rate_limiting/utils": typeof rate_limiting_utils;
  threads: typeof threads;
  "tools/agentAsTool": typeof tools_agentAsTool;
  "tools/searchMessages": typeof tools_searchMessages;
  "tools/updateThreadTitle": typeof tools_updateThreadTitle;
  "tools/weather": typeof tools_weather;
  "usage_tracking/invoicing": typeof usage_tracking_invoicing;
  "usage_tracking/tables": typeof usage_tracking_tables;
  "usage_tracking/usageHandler": typeof usage_tracking_usageHandler;
  utils: typeof utils;
  "workflows/chaining": typeof workflows_chaining;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  rag: import("@convex-dev/rag/_generated/component.js").ComponentApi<"rag">;
};
