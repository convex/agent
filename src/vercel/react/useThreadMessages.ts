"use client";
import {
  omit,
  type BetterOmit,
  type ErrorMessage,
  type Expand,
} from "convex-helpers";
import {
  type PaginatedQueryArgs,
  type UsePaginatedQueryResult,
} from "convex/react";
import type {
  FunctionArgs,
  FunctionReference,
  PaginationOptions,
  PaginationResult,
} from "convex/server";
import { useMemo, useState, useEffect, useRef } from "react";
import type { SyncStreamsReturnValue } from "../client/types.js";
import { sorted } from "../../shared.js";
import { fromUIMessages, type UIMessage } from "../UIMessages.js";
import type {
  Message,
  MessageDoc,
  MessageStatus,
  StreamArgs,
} from "../../validators.js";
import type { StreamQueryArgs, StreamQuery } from "./types.js";
import { useStreamingUIMessages } from "./useStreamingUIMessages.js";
import { resolveStreams, usePaginatedOrders } from "./assemble.js";

export type MessageDocLike = {
  order: number;
  stepOrder: number;
  status: MessageStatus | "streaming";
  message?: Message;
};

export type ThreadMessagesQuery<
  Args = unknown,
  M extends MessageDocLike = MessageDocLike,
> = FunctionReference<
  "query",
  "public",
  {
    threadId: string;
    paginationOpts: PaginationOptions;
    /**
     * If { stream: true } is passed, it will also query for stream deltas.
     * In order for this to work, the query must take as an argument streamArgs.
     */
    streamArgs?: StreamArgs;
  } & Args,
  PaginationResult<M> & { streams?: SyncStreamsReturnValue }
>;

export type ThreadMessagesArgs<
  Query extends ThreadMessagesQuery<unknown, MessageDocLike>,
> =
  Query extends ThreadMessagesQuery<unknown, MessageDocLike>
    ? Expand<BetterOmit<FunctionArgs<Query>, "paginationOpts" | "streamArgs">>
    : never;

export type ThreadMessagesResult<
  Query extends ThreadMessagesQuery<unknown, MessageDocLike>,
> = Query extends ThreadMessagesQuery<unknown, infer M> ? M : never;

/**
 * A hook that fetches messages from a thread.
 *
 * This hook is a wrapper around `usePaginatedQuery` and `useStreamingThreadMessages`.
 * It will fetch both full messages and streaming messages, and merge them together.
 *
 * The query must take as arguments `{ threadId, paginationOpts }` and return a
 * pagination result of objects that extend `MessageDoc`.
 *
 * For streaming, it should look like this:
 * ```ts
 * export const listThreadMessages = query({
 *   args: {
 *     threadId: v.string(),
 *     paginationOpts: paginationOptsValidator,
 *     streamArgs: vStreamArgs,
 *     ... other arguments you want
 *   },
 *   handler: async (ctx, args) => {
 *     // await authorizeThreadAccess(ctx, threadId);
 *     // NOTE: listMessages returns MessageDocs, not UIMessages.
 *     const paginated = await listMessages(ctx, components.agent, args);
 *     const streams = await syncStreams(ctx, components.agent, args);
 *     // Here you could filter out / modify the documents & stream deltas.
 *     return { ...paginated, streams };
 *   },
 * });
 * ```
 *
 * Then the hook can be used like this:
 * ```ts
 * const { results, status, loadMore } = useThreadMessages(
 *   api.myModule.listThreadMessages,
 *   { threadId },
 *   { initialNumItems: 10, stream: true }
 * );
 * ```
 *
 * @param query The query to use to fetch messages.
 * It must take as arguments `{ threadId, paginationOpts }` and return a
 * pagination result of objects that extend `MessageDoc`.
 * To support streaming, it must also take in `streamArgs: vStreamArgs` and
 * return a `streams` object returned from `agent.syncStreams`.
 * @param args The arguments to pass to the query other than `paginationOpts`
 * and `streamArgs`. So `{ threadId }` at minimum, plus any other arguments that
 * you want to pass to the query.
 * @param options The options for the query. Similar to usePaginatedQuery.
 * To enable streaming, pass `stream: true`.
 * @returns The messages. If stream is true, it will return a list of messages
 *   that includes both full messages and streaming messages.
 */
export function useThreadMessages<Query extends ThreadMessagesQuery<any, any>>(
  query: Query,
  args: ThreadMessagesArgs<Query> | "skip",
  options: {
    initialNumItems: number;
    stream?: Query extends StreamQuery
      ? boolean
      : ErrorMessage<"To enable streaming, your query must take in streamArgs: vStreamArgs and return a streams object returned from syncStreams. See docs.">;
  },
): UsePaginatedQueryResult<
  ThreadMessagesResult<Query> & { streaming: boolean; key: string }
> {
  // These are full messages
  const paginated = usePaginatedOrders(
    query,
    args as PaginatedQueryArgs<Query> | "skip",
    { initialNumItems: options.initialNumItems },
  );

  let startOrder = paginated.results.at(-1)?.order ?? 0;
  for (let i = paginated.results.length - 1; i >= 0; i--) {
    const m = paginated.results[i];
    if (!m.streaming && m.status === "pending") {
      // round down to the nearest 10 for some cache benefits
      startOrder = m.order - (m.order % 10);
      break;
    }
  }
  // These are streaming messages that will not include full messages.
  const streams = useStreamingDocs(
    query as StreamQuery<ThreadMessagesArgs<Query>>,
    !options.stream ||
      args === "skip" ||
      paginated.status === "LoadingFirstPage"
      ? "skip"
      : ({ ...args, paginationOpts: { cursor: null, numItems: 0 } } as any),
    { startOrder },
  );

  const threadId = args === "skip" ? undefined : args.threadId;

  const results = useMemo(() => {
    const resolved = resolveStreams(
      paginated.results as MessageDocLike[],
      (streams ?? []).map(({ message, docs }) => ({
        id: message.id,
        order: message.order,
        stepOrder: message.stepOrder,
        live: message.status === "streaming",
        value: docs,
      })),
    );
    return sorted([
      ...resolved.rows.map((m) => ({ ...m, streaming: false })),
      ...resolved.streams.flat().map((m) => ({
        ...m,
        streaming: !m.status || m.status === "pending",
      })),
    ]).map((m) => ({ ...m, key: `${threadId}-${m.order}-${m.stepOrder}` }));
  }, [paginated.results, streams, threadId]);

  return { ...paginated, results } as ThreadMessagesResult<Query> & {
    key: string;
    streaming: boolean;
  };
}

/**
 * @deprecated FYI `useStreamingUIMessages` is likely better for you.
 * A hook that fetches streaming messages from a thread.
 * This ONLY returns streaming messages. To get both, use `useThreadMessages`.
 *
 * @param query The query to use to fetch messages.
 * It must take as arguments `{ threadId, paginationOpts, streamArgs }` and
 * return a `streams` object returned from `agent.syncStreams`.
 * @param args The arguments to pass to the query other than `paginationOpts`
 * and `streamArgs`. So `{ threadId }` at minimum, plus any other arguments that
 * you want to pass to the query.
 * @returns The streaming messages.
 */
export function useStreamingThreadMessages<Query extends StreamQuery<any>>(
  query: Query,
  args:
    | (StreamQueryArgs<Query> & {
        /** @deprecated Pass startOrder to the next argument (third argument). */
        startOrder?: number;
      })
    | "skip",
  options?: {
    startOrder?: number;
    skipStreamIds?: string[];
  },
): Array<MessageDoc> | undefined {
  const queryArgs =
    args === "skip"
      ? args
      : (omit(args, ["startOrder"]) as unknown as StreamQueryArgs<Query>);
  const startOrder =
    args === "skip" ? undefined : (args.startOrder ?? undefined);
  const queryOptions = { startOrder, ...options };
  return useStreamingDocs(query, queryArgs, queryOptions)?.flatMap(
    ({ docs }) => docs,
  );
}

function useStreamingDocs<Query extends StreamQuery<any>>(
  query: Query,
  args: StreamQueryArgs<Query> | "skip",
  options?: {
    startOrder?: number;
    skipStreamIds?: string[];
  },
): { message: UIMessage; docs: MessageDoc[] }[] | undefined {
  const uiMessages = useStreamingUIMessages(query, args, options);
  const [converted, setConverted] = useState<{
    threadId: string;
    messages: { message: UIMessage; docs: MessageDoc[] }[];
  }>();
  const generationRef = useRef(0);
  const threadId = args === "skip" ? undefined : args.threadId;

  useEffect(() => {
    if (threadId === undefined || !uiMessages) {
      return;
    }
    const currentGeneration = ++generationRef.current;
    (async () => {
      const messages = await Promise.all(
        uiMessages.map(async (message) => ({
          message,
          docs: await fromUIMessages([message], { threadId }),
        })),
      );
      if (generationRef.current === currentGeneration) {
        setConverted({ threadId, messages });
      }
    })();
  }, [uiMessages, threadId]);

  return uiMessages && converted && converted.threadId === threadId
    ? converted.messages
    : undefined;
}
