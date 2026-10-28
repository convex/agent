"use client";
import { usePaginatedQuery } from "convex-helpers/react";
import type {
  PaginatedQueryArgs,
  PaginatedQueryReference,
  UsePaginatedQueryReturnType,
} from "convex/react";
import { getFunctionName } from "convex/server";
import { convexToJson, type Value } from "convex/values";
import { useEffect, useMemo, useState } from "react";

type Positioned = { order: number; stepOrder: number };

// Rows fetched per automatic page while finishing the oldest visible order.
const AUTO_PAGE_SIZE = 100;

/**
 * usePaginatedQuery over a thread's messages, where a page boundary can fall
 * anywhere inside an order. The oldest order the caller asked to see is
 * loaded to its first row with further pages before it settles, and rows of
 * older orders read along the way stay hidden until the next `loadMore`, so
 * the results always start at an order boundary.
 */
export function usePaginatedOrders<Query extends PaginatedQueryReference>(
  query: Query,
  args: PaginatedQueryArgs<Query> | "skip",
  options: { initialNumItems: number },
): UsePaginatedQueryReturnType<Query> {
  const paginated = usePaginatedQuery(query, args, options);
  const items = paginated.results as Positioned[];
  const queryKey = `${getFunctionName(query)}:${
    args === "skip" ? "skip" : JSON.stringify(convexToJson(args as Value))
  }`;

  const [state, setState] = useState<{
    queryKey: string;
    target?: number;
    loadingFrom?: string;
  }>({ queryKey });
  let { target, loadingFrom } = state.queryKey === queryKey ? state : {};

  let oldest: Positioned | undefined;
  for (const item of items) {
    if (
      !oldest ||
      item.order < oldest.order ||
      (item.order === oldest.order && item.stepOrder < oldest.stepOrder)
    ) {
      oldest = item;
    }
  }
  const oldestKey = oldest && `${oldest.order}/${oldest.stepOrder}`;
  if (!oldest) {
    target = undefined;
  } else {
    if (
      loadingFrom !== undefined &&
      (loadingFrom !== oldestKey || paginated.status === "Exhausted")
    ) {
      target = oldest.order;
      loadingFrom = undefined;
    }
    if (target === undefined || oldest.order > target) {
      target = oldest.order;
    }
  }
  if (
    state.queryKey !== queryKey ||
    state.target !== target ||
    state.loadingFrom !== loadingFrom
  ) {
    setState({ queryKey, target, loadingFrom });
  }

  const completing =
    !!oldest &&
    paginated.status === "CanLoadMore" &&
    oldest.order === target &&
    oldest.stepOrder > 0;
  const autoPageSize = completing
    ? Math.min(oldest!.stepOrder, AUTO_PAGE_SIZE)
    : 0;
  const underlyingLoadMore = paginated.loadMore;
  // usePaginatedQuery ignores a second loadMore until the page it started
  // arrives, so a repeated effect (StrictMode) requests one page.
  useEffect(() => {
    if (completing) underlyingLoadMore(autoPageSize);
  }, [completing, autoPageSize, underlyingLoadMore]);

  const results = paginated.results;
  const visible = useMemo(() => {
    if (target === undefined) return results;
    const kept = results.filter((item) => (item as Positioned).order >= target);
    return kept.length === results.length ? results : kept;
  }, [results, target]);
  const hidden = visible.length < paginated.results.length;
  let status = paginated.status;
  if (completing) {
    status = "LoadingMore";
  } else if (hidden && status === "Exhausted") {
    status = "CanLoadMore";
  }
  return {
    results: visible,
    status,
    isLoading: status === "LoadingFirstPage" || status === "LoadingMore",
    loadMore: (numItems: number) => {
      if (hidden && oldest) {
        setState({ queryKey, target: oldest.order });
      } else if (status === "CanLoadMore") {
        setState({ queryKey, target, loadingFrom: oldestKey });
        underlyingLoadMore(numItems);
      }
    },
  } as UsePaginatedQueryReturnType<Query>;
}

/**
 * A stream's message for an order, starting at `stepOrder`. A stream carries
 * every step of its generation from there on.
 */
export type StreamCandidate<S> = {
  id: string;
  order: number;
  stepOrder: number;
  live: boolean;
  value: S;
};

const byStart = <S>(a: StreamCandidate<S>, b: StreamCandidate<S>) =>
  a.order - b.order ||
  a.stepOrder - b.stepOrder ||
  Number(a.live) - Number(b.live) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Resolves which saved rows and which streams are shown, per order:
 * - The live stream that started latest wins from its start: rows from there
 *   are replaced, whatever their status or the query's filters.
 * - A finished or aborted stream is shown only if it starts before that and
 *   no finalized (not pending) row exists at or after its start, so saved
 *   messages win. It replaces the pending rows from its start.
 * Of streams starting at the same step, a live one wins, then the greatest id.
 */
export function resolveStreams<
  R extends { order: number; stepOrder: number; status: string },
  S,
>(rows: R[], streams: StreamCandidate<S>[]): { rows: R[]; streams: S[] } {
  const sorted = [...streams]
    .sort(byStart)
    .filter(
      (s, i, all) =>
        all[i + 1]?.order !== s.order || all[i + 1]?.stepOrder !== s.stepOrder,
    );
  const liveFrom = new Map<number, number>();
  for (const s of sorted) if (s.live) liveFrom.set(s.order, s.stepOrder);
  const shown = sorted.filter((s) =>
    s.live
      ? liveFrom.get(s.order) === s.stepOrder
      : s.stepOrder < (liveFrom.get(s.order) ?? Infinity) &&
        !rows.some(
          (r) =>
            r.order === s.order &&
            r.stepOrder >= s.stepOrder &&
            r.status !== "pending",
        ),
  );
  const replacedFrom = new Map<number, number>();
  for (const s of shown) {
    replacedFrom.set(
      s.order,
      Math.min(s.stepOrder, replacedFrom.get(s.order) ?? Infinity),
    );
  }
  return {
    rows: rows.filter(
      (r) => r.stepOrder < (replacedFrom.get(r.order) ?? Infinity),
    ),
    streams: shown.map((s) => s.value),
  };
}
