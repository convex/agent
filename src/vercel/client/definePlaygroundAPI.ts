import {
  actionGeneric,
  mutationGeneric,
  paginationOptsValidator,
  queryGeneric,
  type ApiFromModules,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
} from "convex/server";
import { v } from "convex/values";
import type { Instructions } from "ai";
import {
  vContextOptions,
  vMessage,
  vMessageDoc,
  vPaginationResult,
  vStorageOptions,
  vThreadDoc,
  vStreamArgs,
  type MessageDoc,
} from "../../validators.js";
import { createThread as createThread_ } from "../../client/threads.js";
import {
  extractText,
  getModelName,
  getProviderName,
  isTool,
  withDerivedReasoning,
} from "../../shared.js";
import { serializeResponseMessages, toModelMessage } from "../mapping.js";
import type { Agent } from "../index.js";
import { listMessages as listMessages_ } from "./messages.js";
import { syncStreams, vStreamMessagesReturnValue } from "./streaming.js";
import type {
  AgentComponent,
  ContextOptions,
  StorageOptions,
} from "./types.js";

export type PlaygroundAPI = ApiFromModules<{
  playground: ReturnType<typeof definePlaygroundAPI>;
}>["playground"];

export type AgentsFn<DataModel extends GenericDataModel> = (
  ctx: GenericActionCtx<DataModel> | GenericQueryCtx<DataModel>,
  args: { userId: string | undefined; threadId: string | undefined },
) => Agent[] | Promise<Agent[]>;

/** Metadata for an agent defined in a separate `"use node"` module. */
export type PlaygroundAgentInfo = {
  name: string;
  instructions?: Instructions | undefined;
  contextOptions?: ContextOptions | undefined;
  storageOptions?: StorageOptions | undefined;
  maxRetries?: number | undefined;
  tools?: string[] | undefined;
};

function agentName(agent: Agent, index: number) {
  const name = agent.options.name;
  if (!name) {
    console.warn(
      `Agent has no name (instructions: ${agent.options.instructions})`,
    );
  }
  return name ?? `Agent ${index} (missing 'name')`;
}

function agentInfo(value: Agent | PlaygroundAgentInfo, index: number) {
  if (!("options" in value)) {
    return {
      ...value,
      tools: value.tools ?? [],
    };
  }
  const { options } = value;
  return {
    name: agentName(value, index),
    instructions: options.instructions,
    contextOptions: options.contextOptions,
    storageOptions: options.storageOptions,
    maxRetries: options.callSettings?.maxRetries,
    tools: options.tools ? Object.keys(options.tools) : [],
  };
}

function apiKeyValidator(component: AgentComponent) {
  return async (ctx: QueryCtx | MutationCtx | ActionCtx, apiKey: string) => {
    await ctx.runQuery(component.apiKeys.validate, { apiKey });
  };
}

/** Define playground queries and mutations without importing Node-only agents. */
export function definePlaygroundQueries<DataModel extends GenericDataModel>(
  component: AgentComponent,
  {
    agents: agentsOrFn,
    userNameLookup,
  }: {
    agents:
      | Array<Agent | PlaygroundAgentInfo>
      | ((
          ctx: GenericQueryCtx<DataModel>,
          args: { userId: string | undefined; threadId: string | undefined },
        ) =>
          | Array<Agent | PlaygroundAgentInfo>
          | Promise<Array<Agent | PlaygroundAgentInfo>>);
    userNameLookup?: (
      ctx: GenericQueryCtx<DataModel>,
      userId: string,
    ) => string | Promise<string>;
  },
) {
  const validateApiKey = apiKeyValidator(component);

  const isApiKeyValid = queryGeneric({
    args: { apiKey: v.string() },
    handler: async (ctx, args) => {
      try {
        await validateApiKey(ctx, args.apiKey);
        return true;
      } catch {
        return false;
      }
    },
    returns: v.boolean(),
  });

  const listAgents = queryGeneric({
    args: {
      apiKey: v.string(),
      userId: v.optional(v.string()),
      threadId: v.optional(v.string()),
    },
    handler: async (ctx: GenericQueryCtx<DataModel>, args) => {
      await validateApiKey(ctx, args.apiKey);
      const agents = Array.isArray(agentsOrFn)
        ? agentsOrFn
        : await agentsOrFn(ctx, {
            userId: args.userId,
            threadId: args.threadId,
          });
      return agents.map(agentInfo);
    },
  });

  const listUsers = queryGeneric({
    args: { apiKey: v.string(), paginationOpts: paginationOptsValidator },
    handler: async (ctx, args) => {
      await validateApiKey(ctx, args.apiKey);
      const users = await ctx.runQuery(component.users.listUsersWithThreads, {
        paginationOpts: args.paginationOpts,
      });
      return {
        ...users,
        page: await Promise.all(
          users.page.map(async (userId) => ({
            _id: userId,
            name: userNameLookup ? await userNameLookup(ctx, userId) : userId,
          })),
        ),
      };
    },
    returns: vPaginationResult(v.object({ _id: v.string(), name: v.string() })),
  });

  const listThreads = queryGeneric({
    args: {
      apiKey: v.string(),
      userId: v.optional(v.string()),
      paginationOpts: paginationOptsValidator,
    },
    handler: async (ctx, args) => {
      await validateApiKey(ctx, args.apiKey);
      const results = await ctx.runQuery(
        component.threads.listThreadsByUserId,
        {
          userId: args.userId,
          paginationOpts: args.paginationOpts,
          order: "desc",
        },
      );
      return {
        ...results,
        page: await Promise.all(
          results.page.map(async (thread) => {
            const {
              page: [last],
            } = await ctx.runQuery(component.messages.listMessagesByThreadId, {
              threadId: thread._id,
              order: "desc",
              paginationOpts: { numItems: 1, cursor: null },
            });
            return {
              ...thread,
              lastAgentName: last?.agentName,
              latestMessage: last?.text,
              lastMessageAt: last?._creationTime,
            };
          }),
        ),
      };
    },
    returns: vPaginationResult(
      v.object({
        ...vThreadDoc.fields,
        lastAgentName: v.optional(v.string()),
        latestMessage: v.optional(v.string()),
        lastMessageAt: v.optional(v.number()),
      }),
    ),
  });

  const listMessages = queryGeneric({
    args: {
      apiKey: v.string(),
      threadId: v.string(),
      paginationOpts: paginationOptsValidator,
      streamArgs: vStreamArgs,
    },
    handler: async (ctx, args) => {
      await validateApiKey(ctx, args.apiKey);
      const paginated = await listMessages_(ctx, component, {
        threadId: args.threadId,
        paginationOpts: args.paginationOpts,
        statuses: ["success", "failed", "pending"],
      });
      const streams = await syncStreams(ctx, component, args);

      return { ...paginated, streams };
    },
    returns: vStreamMessagesReturnValue,
  });

  const createThread = mutationGeneric({
    args: {
      apiKey: v.string(),
      userId: v.string(),
      title: v.optional(v.string()),
      summary: v.optional(v.string()),
      /** @deprecated Unused. */
      agentName: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
      await validateApiKey(ctx, args.apiKey);
      const threadId = await createThread_(ctx, component, {
        userId: args.userId,
        title: args.title,
        summary: args.summary,
      });
      return { threadId };
    },
    returns: v.object({ threadId: v.string() }),
  });

  return {
    isApiKeyValid,
    listUsers,
    listThreads,
    listMessages,
    listAgents,
    createThread,
  };
}

/** Define playground actions, including in a `"use node"` module. */
export function definePlaygroundActions<DataModel extends GenericDataModel>(
  component: AgentComponent,
  { agents: agentsOrFn }: { agents: Agent[] | AgentsFn<DataModel> },
) {
  const validateApiKey = apiKeyValidator(component);

  async function getAgent(
    ctx: GenericActionCtx<DataModel>,
    args: {
      agentName: string;
      userId?: string;
      threadId?: string;
    },
  ) {
    const agents = Array.isArray(agentsOrFn)
      ? agentsOrFn
      : await agentsOrFn(ctx, {
          userId: args.userId,
          threadId: args.threadId,
        });
    const agent = agents.find(
      (agent, index) => agentName(agent, index) === args.agentName,
    );
    if (!agent) throw new Error(`Unknown agent: ${args.agentName}`);
    return agent;
  }

  const generateText = actionGeneric({
    args: {
      apiKey: v.string(),
      agentName: v.string(),
      userId: v.string(),
      threadId: v.string(),
      contextOptions: v.optional(vContextOptions),
      storageOptions: v.optional(vStorageOptions),
      prompt: v.optional(v.string()),
      messages: v.optional(v.array(vMessage)),
      system: v.optional(v.string()),
    },
    handler: async (ctx: GenericActionCtx<DataModel>, args) => {
      const {
        apiKey,
        agentName,
        userId,
        threadId,
        contextOptions,
        storageOptions,
        system,
        messages,
        ...rest
      } = args;
      await validateApiKey(ctx, apiKey);
      const agent = await getAgent(ctx, { agentName, userId, threadId });
      const { text, steps } = await agent.streamText(
        ctx,
        { threadId, userId },
        {
          ...rest,
          ...(system ? { system } : {}),
          ...(messages ? { messages: messages.map(toModelMessage) } : {}),
        },
        { contextOptions, storageOptions, saveStreamDeltas: true },
      );
      const outputMessages: MessageDoc[][] = [];
      for (const step of await steps) {
        const { messages } = await serializeResponseMessages(
          ctx,
          component,
          step,
          {
            model: getModelName(agent.options.languageModel),
            provider: getProviderName(agent.options.languageModel),
          },
          step.response.messages,
        );
        outputMessages.push(
          messages.map((messageWithMetadata, i) =>
            withDerivedReasoning({
              ...messageWithMetadata,
              tool: isTool(messageWithMetadata.message),
              text: extractText(messageWithMetadata.message),
              status: "success",
              providerMetadata: {},
              threadId,
              _id: crypto.randomUUID(),
              _creationTime: Date.now(),
              order: 0,
              stepOrder: i + 1,
            } satisfies MessageDoc),
          ),
        );
      }
      return { text: await text, messages: outputMessages.flat() };
    },
    returns: v.object({ text: v.string(), messages: v.array(vMessageDoc) }),
  });

  const fetchPromptContext = actionGeneric({
    args: {
      apiKey: v.string(),
      agentName: v.string(),
      userId: v.optional(v.string()),
      threadId: v.optional(v.string()),
      searchText: v.optional(v.string()),
      targetMessageId: v.optional(v.string()),
      contextOptions: vContextOptions,
      // @deprecated use searchText and targetMessageId instead
      messages: v.optional(v.array(vMessage)),
      beforeMessageId: v.optional(v.string()),
    },
    handler: async (ctx: GenericActionCtx<DataModel>, args) => {
      await validateApiKey(ctx, args.apiKey);
      const agent = await getAgent(ctx, args);
      const contextOptions = args.contextOptions;
      const targetMessageId = args.targetMessageId ?? args.beforeMessageId;
      if (targetMessageId) {
        contextOptions.recentMessages =
          (contextOptions.recentMessages ?? 10) + 1;
      }
      const messages = await agent.fetchContextMessages(ctx, {
        userId: args.userId,
        threadId: args.threadId,
        targetMessageId,
        searchText: args.searchText,
        contextOptions: args.contextOptions,
        messages: args.messages?.map(toModelMessage),
      });
      const targetMessageIndex = messages.findIndex(
        (m) => m._id === targetMessageId,
      );
      if (targetMessageIndex !== -1) {
        return messages.slice(0, targetMessageIndex);
      }
      return messages;
    },
  });

  return { generateText, fetchPromptContext };
}

export function definePlaygroundAPI<DataModel extends GenericDataModel>(
  component: AgentComponent,
  options: {
    agents: Agent[] | AgentsFn<DataModel>;
    userNameLookup?: (
      ctx: GenericQueryCtx<DataModel>,
      userId: string,
    ) => string | Promise<string>;
  },
) {
  return {
    ...definePlaygroundQueries(component, options),
    ...definePlaygroundActions(component, options),
  };
}

type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;
type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;
