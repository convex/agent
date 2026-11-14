import { omit, pick } from "convex-helpers";
import {
  QueryStream,
  type IndexBounds,
  type IndexKey,
} from "convex-helpers/server/stream";
import type {
  IndexRange,
  IndexRangeBuilder,
  WithoutSystemFields,
} from "convex/server";
import { getDocumentSize, v, type Infer, type Value } from "convex/values";
import { extractText } from "../shared.js";
import type { Message } from "../validators.js";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

type MessageFields = WithoutSystemFields<Doc<"messages">>;

const PAYLOAD_FIELDS = [
  "providerOptions",
  "usage",
  "providerMetadata",
  "sources",
  "warnings",
  "reasoning",
  "reasoningDetails",
] as const satisfies (keyof MessageFields)[];
const STORAGE_FIELDS = [
  "textLengths",
  "payloadId",
  "payloadSize",
] as const satisfies (keyof MessageFields)[];

const KEY_FIELDS = [
  "threadId",
  "status",
  "tool",
  "order",
  "stepOrder",
] as const satisfies (keyof MessageFields)[];

export type Payload = Pick<MessageFields, (typeof PAYLOAD_FIELDS)[number]>;

/**
 * "text" is a message's role and text, "model" what the model reads, and
 * "full" adds provider metadata, usage, sources and warnings.
 */
export const vMessageView = v.union(
  v.literal("text"),
  v.literal("model"),
  v.literal("full"),
);
export type MessageView = Infer<typeof vMessageView>;

// Convex allows a function 4,096 `db.get` and `db.query` calls. Some are left
// for the caller.
const MAX_INDEX_RANGES = 4_000;

// As long as a document id can be (a five-byte table number, 16-byte id and
// two-byte footer in base32), to size a row before its payload has one.
const ID_SIZE = "-".repeat(37);

// A payload row costs a full read one more document, which takes about as
// long as reading a few kilobytes more, so smaller payloads stay on the row.
const MIN_PAYLOAD_SIZE = 2_048;

/**
 * Writes the message's payload, replacing the existing one, and returns the
 * row to store. A message is split only when its row and payload together
 * are no larger than the message with its text twice, as rows were saved
 * before payloads, so a full read never reads more than it did.
 */
export async function storeMessage(
  ctx: MutationCtx,
  fields: MessageFields,
  existing?: Pick<Doc<"messages">, "payloadId">,
): Promise<{ row: MessageFields; payload: Payload }> {
  // Unset text hides a message from search. Rows an older extractText wrote
  // are brought in line when rewritten.
  const text =
    fields.message && fields.text !== undefined
      ? extractText(fields.message)
      : fields.text;
  const payload = Object.fromEntries(
    Object.entries(pick(fields, PAYLOAD_FIELDS)).filter(
      ([, value]) => value !== undefined,
    ),
  ) as Payload;
  const row = {
    ...(omit(fields, [...PAYLOAD_FIELDS, ...STORAGE_FIELDS]) as MessageFields),
    text,
    ...(fields.message && leaveOutText(fields.message, text)),
  };
  const doc = { ...pick(fields, KEY_FIELDS), ...payload };
  const payloadSize = getDocumentSize(doc as Record<string, Value>);
  const splits =
    payloadSize >= MIN_PAYLOAD_SIZE &&
    getDocumentSize({ ...row, payloadId: ID_SIZE, payloadSize } as never) +
      getDocumentSize({ ...doc, _id: ID_SIZE, _creationTime: 0 } as never) <=
      getDocumentSize({ ...omit(fields, STORAGE_FIELDS), text } as never);
  if (!splits) {
    if (existing?.payloadId) {
      await ctx.db.delete("messagePayloads", existing.payloadId);
    }
    return { row: { ...row, ...payload }, payload };
  }
  let payloadId = existing?.payloadId;
  if (payloadId) {
    await ctx.db.replace("messagePayloads", payloadId, doc);
  } else {
    payloadId = await ctx.db.insert("messagePayloads", doc);
  }
  return { row: { ...row, payloadId, payloadSize }, payload };
}

/**
 * The message without the text its row holds, and the length of each text
 * part's text, so that the row's text, cut at those lengths and the single
 * spaces `extractText` joins them with, gives each part's text back. A message
 * whose row holds no text, or that wouldn't shrink, is stored whole.
 */
function leaveOutText(message: Message, text: string | undefined) {
  if (!text) {
    return { message };
  }
  const textLengths: number[] = [];
  const content =
    typeof message.content === "string"
      ? ""
      : message.content.map((part) => {
          if (part.type !== "text") {
            return part;
          }
          textLengths.push(part.text.length);
          return { ...part, text: "" };
        });
  if (typeof message.content === "string") {
    textLengths.push(text.length);
  }
  const leftOut = { message: { ...message, content } as Message, textLengths };
  return getDocumentSize(leftOut) < getDocumentSize({ message })
    ? leftOut
    : { message };
}

function putBackText(row: Doc<"messages">): Message | undefined {
  const { message, textLengths } = row;
  if (!message || !textLengths) {
    return message;
  }
  const text = row.text ?? "";
  const changed = new Error(
    `Message ${row._id}'s text no longer matches its stored message`,
  );
  if (typeof message.content === "string") {
    if (textLengths[0] !== text.length) {
      throw changed;
    }
    return { ...message, content: text } as Message;
  }
  let start = 0;
  let next = 0;
  const content = message.content.map((part) => {
    if (part.type !== "text") {
      return part;
    }
    const length = textLengths[next++];
    if (!length) {
      return part;
    }
    const partText = text.slice(start, start + length);
    start += length + 1;
    return { ...part, text: partText };
  });
  if (next !== textLengths.length || start !== text.length + 1) {
    throw changed;
  }
  return { ...message, content } as Message;
}

function withText(row: Doc<"messages">): Doc<"messages"> {
  const doc = omit(row, STORAGE_FIELDS);
  return row.message ? { ...doc, message: putBackText(row) } : doc;
}

/** The row as the model reads it: its message whole, without its payload. */
export function modelMessage(row: Doc<"messages">): Doc<"messages"> {
  return omit(withText(row), PAYLOAD_FIELDS);
}

/** The message as its role and text, or "" without any text. */
function textMessage(row: Doc<"messages">): Doc<"messages"> {
  const { message, ...doc } = modelMessage(row);
  return message
    ? ({
        ...doc,
        message: { role: message.role, content: extractText(message) ?? "" },
      } as Doc<"messages">)
    : doc;
}

/** The message as a write stored it, from its row and payload. */
export function storedMessage(
  row: Doc<"messages">,
  payload: Payload,
): Doc<"messages"> {
  return { ...modelMessage(row), ...payload };
}

export async function readMessage(
  ctx: QueryCtx,
  row: Doc<"messages">,
  view: MessageView = "full",
): Promise<Doc<"messages">> {
  return (await readMessages(ctx, [row], view))[0];
}

type Position = Pick<Doc<"messages">, (typeof KEY_FIELDS)[number]>;

/**
 * The messages as the view returns them. A page's rows of each thread, status
 * and kind are every message between the first and last, so a full read of a
 * page reads their payloads in a few index ranges, and none of a message
 * outside the page. Other rows' payloads are read one by one, or, for more
 * rows than a function may read one by one, in ranges over the nearest rows.
 */
export async function readMessages(
  ctx: QueryCtx,
  rows: Doc<"messages">[],
  view: MessageView = "full",
  { page = false } = {},
): Promise<Doc<"messages">[]> {
  if (view === "text") {
    return rows.map(textMessage);
  }
  if (view === "model") {
    return rows.map(modelMessage);
  }
  const split = rows.filter((row) => row.payloadId);
  const runs = page
    ? spans(split)
    : nearest(split, MAX_INDEX_RANGES - rows.length);
  const payloads = new Map<string, Doc<"messagePayloads">>();
  for (const docs of await Promise.all(
    runs
      .filter(([first, last]) => first !== last)
      .map((run) => payloadsBetween(ctx, ...run)),
  )) {
    for (const doc of docs) {
      payloads.set(doc._id, doc);
    }
  }
  const missing = split.filter((row) => !payloads.has(row.payloadId!));
  for (let i = 0; i < missing.length; i += CONCURRENT_READS) {
    const docs = await Promise.all(
      missing
        .slice(i, i + CONCURRENT_READS)
        .map((row) => ctx.db.get("messagePayloads", row.payloadId!)),
    );
    for (const doc of docs) {
      if (doc) {
        payloads.set(doc._id, doc);
      }
    }
  }
  return rows.map((row) => {
    if (!row.payloadId) {
      return withText(row);
    }
    const payload = payloads.get(row.payloadId);
    if (!payload) {
      throw new Error(
        `Payload ${row.payloadId} of message ${row._id} not found`,
      );
    }
    return storedMessage(
      row,
      omit(payload, ["_id", "_creationTime", ...KEY_FIELDS]),
    );
  });
}

// Convex allows a function 1,000 concurrent operations.
const CONCURRENT_READS = 500;

const byPosition = (a: Position, b: Position) =>
  a.order - b.order || a.stepOrder - b.stepOrder;

type Run = [Doc<"messages">, Doc<"messages">];

/** The rows of each thread, status and kind, in order. */
function groups(rows: Doc<"messages">[]) {
  const byKey = new Map<string, Doc<"messages">[]>();
  for (const row of rows) {
    const key = `${row.threadId}:${row.status}:${row.tool}`;
    const group = byKey.get(key);
    if (group) {
      group.push(row);
    } else {
      byKey.set(key, [row]);
    }
  }
  return [...byKey.values()].map((group) => group.sort(byPosition));
}

/** The first and last row of each thread, status and kind of message. */
function spans(rows: Doc<"messages">[]): Run[] {
  return groups(rows).map((group) => [group[0], group[group.length - 1]]);
}

const rangesFor = ([first, last]: Run) =>
  Math.min(last.order - first.order + 1, 3);

/**
 * Each row on its own, joined with its nearest neighbors until reading them
 * takes no more than `budget` index ranges, so a range reads as few payloads
 * of other messages as it can.
 */
function nearest(rows: Doc<"messages">[], budget: number): Run[] {
  const sorted = groups(rows);
  const runs = sorted.map((group) => group.map((row): Run => [row, row]));
  let total = rows.length;
  if (total <= budget) {
    return runs.flat();
  }
  const gaps = sorted
    .flatMap((group, g) =>
      group.slice(1).map((row, i) => ({
        g,
        i,
        orders: row.order - group[i].order,
        steps: row.stepOrder - group[i].stepOrder,
      })),
    )
    .sort((a, b) => a.orders - b.orders || a.steps - b.steps);
  // Each row's run, by the index of the run's first row in its group.
  const starts = sorted.map((group) => group.map((_, i) => i));
  const startOf = (g: number, i: number): number =>
    starts[g][i] === i ? i : (starts[g][i] = startOf(g, starts[g][i]));
  for (const { g, i } of gaps) {
    if (total <= budget) {
      break;
    }
    const a = startOf(g, i);
    const b = startOf(g, i + 1);
    const joined: Run = [runs[g][a][0], runs[g][b][1]];
    total += rangesFor(joined) - rangesFor(runs[g][a]) - rangesFor(runs[g][b]);
    runs[g][a] = joined;
    starts[g][b] = a;
  }
  return runs.flatMap((group, g) =>
    group.filter((_, i) => startOf(g, i) === i),
  );
}

async function payloadsBetween(ctx: QueryCtx, first: Position, last: Position) {
  const { threadId, status, tool } = first;
  const between = (
    bounds: (
      q: IndexRangeBuilder<
        Doc<"messagePayloads">,
        ["threadId", "status", "tool", "order", "stepOrder", "_creationTime"],
        3
      >,
    ) => IndexRange,
  ) =>
    ctx.db
      .query("messagePayloads")
      .withIndex("threadId_status_tool_order_stepOrder", (q) =>
        bounds(
          q.eq("threadId", threadId).eq("status", status).eq("tool", tool),
        ),
      )
      .collect();
  if (first.order === last.order) {
    return between((q) =>
      q
        .eq("order", first.order)
        .gte("stepOrder", first.stepOrder)
        .lte("stepOrder", last.stepOrder),
    );
  }
  // Orders are integers, so adjacent ones have nothing between them. Were one
  // not, a payload between them would be read by itself.
  const ranges = [
    between((q) =>
      q.eq("order", first.order).gte("stepOrder", first.stepOrder),
    ),
    between((q) => q.eq("order", last.order).lte("stepOrder", last.stepOrder)),
  ];
  if (last.order - first.order > 1) {
    ranges.push(
      between((q) => q.gt("order", first.order).lt("order", last.order)),
    );
  }
  return (await Promise.all(ranges)).flat();
}

/** Keeps a payload keyed like its message when only the status changes. */
export async function patchStatus(
  ctx: MutationCtx,
  row: Pick<Doc<"messages">, "_id" | "payloadId">,
  patch: Partial<Doc<"messages">> & Pick<Doc<"messages">, "status">,
) {
  await ctx.db.patch("messages", row._id, patch);
  if (row.payloadId) {
    await ctx.db.patch("messagePayloads", row.payloadId, {
      status: patch.status,
    });
  }
}

export async function deletePayload(
  ctx: MutationCtx,
  row: Pick<Doc<"messages">, "payloadId">,
) {
  if (row.payloadId) {
    await ctx.db.delete("messagePayloads", row.payloadId);
  }
}

/**
 * The rows, each charging a byte budget for the payload a full read joins, so
 * a page of them ends where a page of rows saved whole would. Wrap each stream
 * before merging, so rows a merge reads ahead are charged too.
 */
export class ChargingPayloads extends QueryStream<Doc<"messages">> {
  #rows: QueryStream<Doc<"messages">>;
  constructor(rows: QueryStream<Doc<"messages">>) {
    super();
    this.#rows = rows;
  }
  iterWithKeys(trackBandwidth = false) {
    const rows = this.#rows.iterWithKeys(trackBandwidth);
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<
        [Doc<"messages"> | null, IndexKey, number],
        undefined
      > {
        for await (const [row, indexKey, bandwidth] of rows) {
          yield [row, indexKey, bandwidth + (row?.payloadSize ?? 0)];
        }
      },
    };
  }
  narrow(indexBounds: IndexBounds) {
    return new ChargingPayloads(this.#rows.narrow(indexBounds));
  }
  getOrder() {
    return this.#rows.getOrder();
  }
  getIndexFields() {
    return this.#rows.getIndexFields();
  }
  getEqualityIndexFilter() {
    return this.#rows.getEqualityIndexFilter();
  }
}
