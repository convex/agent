type Flags = Partial<Record<string, true>>;
type Part = Record<string, unknown>;
type ProviderOptions = Record<string, Record<string, unknown>>;

// Convex refuses some JSON: a field name that starts with "$" or isn't
// printable ASCII, objects over 1,024 fields, arrays over 8,192 items, and
// nesting over 16 levels (https://docs.convex.dev/production/state/limits).
// A tool result's value sits six levels into a message and fails at twelve
// levels of its own; ten leaves a level for a query that wraps the page. A
// value that doesn't fit is stored as its JSON text and flagged outside
// application data, so a value can't pass for an encoded one.
const MAX_DEPTH = 10;

// A stored message keeps the flag in its part's providerOptions, which every
// version's schema accepts, so a rollback can still deploy over these rows.
// UI parts and stream chunks aren't schema checked and keep it in `toolJson`.
const NAMESPACE = "convexAgent";

/**
 * Send tool values as they are, and only if Convex refuses them, again with
 * the ones it can't hold as JSON text. Convex already checks every value it's
 * sent, so checking first would walk every tool value twice on each write. A
 * refused write commits nothing, so sending it again is safe.
 */
export async function sendToolJson<A, R>(
  value: A,
  encode: (value: A) => A,
  send: (value: A) => Promise<R>,
): Promise<R> {
  try {
    return await send(value);
  } catch (error) {
    const encoded = encode(value);
    if (encoded === value) throw error;
    return await send(encoded);
  }
}

export function mapChanged<T>(list: T[], fn: (item: T) => T): T[] {
  let mapped: T[] | undefined;
  for (let i = 0; i < list.length; i++) {
    const item = fn(list[i]);
    if (item !== list[i]) (mapped ??= list.slice())[i] = item;
  }
  return mapped ?? list;
}

export function encodeToolJsonChunks<T extends { type: string }>(
  chunks: T[],
): T[] {
  return mapChanged(chunks, (chunk) =>
    encodeToolJsonFields(chunk, toolChunkJsonFields(chunk.type)),
  );
}

/** Store each tool value in these messages that Convex refused as JSON text. */
export function encodeToolJsonInMessages<M extends { message?: object }>(
  docs: M[],
): M[] {
  return mapChanged(docs, (doc) => {
    const content = (doc.message as Part | undefined)?.content;
    if (!Array.isArray(content)) return doc;
    const encoded = mapChanged(content as Part[], encodeStoredPart);
    return encoded === content
      ? doc
      : { ...doc, message: { ...doc.message, content: encoded } };
  });
}

function encodeStoredPart(part: Part): Part {
  if (part.type === "tool-call") {
    const call = encodeToolJsonFields(part, ["input"], "providerOptions");
    return call === part ? part : { ...call, args: call.input };
  }
  const output = part.output as Part | undefined;
  if (output?.type === "json" || output?.type === "error-json") {
    const encoded = encodeToolJsonFields(output, ["value"], "providerOptions");
    return encoded === output ? part : { ...part, output: encoded };
  }
  return part;
}

export function encodeToolJsonFields<T extends object>(
  part: T,
  keys: readonly string[],
  where: "part" | "providerOptions" = "part",
): T {
  let encoded: Part | undefined;
  let flags: Flags | undefined;
  for (const key of keys) {
    const value = (part as Part)[key];
    if (fitsConvex(value, 0)) continue;
    encoded ??= { ...(part as Part) };
    flags ??= {};
    // JSON semantics, as the AI SDK sends a tool value to the model.
    encoded[key] = JSON.stringify(value);
    flags[key] = true;
  }
  if (!encoded) return part;
  if (where === "part") {
    encoded.toolJson = flags;
  } else {
    const options = (encoded.providerOptions ?? {}) as ProviderOptions;
    encoded.providerOptions = { ...options, [NAMESPACE]: { toolJson: flags } };
  }
  return encoded as T;
}

export function hasToolJson(part: object): boolean {
  const options = (part as Part).providerOptions as ProviderOptions | undefined;
  return !!(options?.[NAMESPACE]?.toolJson ?? (part as Part).toolJson);
}

export function decodeToolJsonFields<T extends object>(
  part: T,
  keys: readonly string[],
): T {
  const options = (part as Part).providerOptions as ProviderOptions | undefined;
  const inOptions = options?.[NAMESPACE]?.toolJson as Flags | undefined;
  const flags = inOptions ?? ((part as Part).toolJson as Flags | undefined);
  if (!flags) return part;
  const decoded: Part = { ...(part as Part) };
  if (inOptions) {
    const { [NAMESPACE]: _, ...rest } = options!;
    if (Object.keys(rest).length) decoded.providerOptions = rest;
    else delete decoded.providerOptions;
  } else {
    delete decoded.toolJson;
  }
  for (const key of keys) {
    const text = decoded[key];
    if (flags[key] === true && typeof text === "string") {
      decoded[key] = JSON.parse(text);
    }
  }
  return decoded as T;
}

export function toolChunkJsonFields(type: string): ("input" | "output")[] {
  switch (type) {
    case "tool-input-available":
    case "tool-input-error":
      return ["input"];
    case "tool-output-available":
      return ["output"];
    default:
      return [];
  }
}

function fitsConvex(value: unknown, depth: number): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(value)) {
    if (value.length > 8_192) return false;
    for (const item of value) {
      if (!fitsConvex(item, depth + 1)) return false;
    }
    return true;
  }
  let fields = 0;
  for (const key in value) {
    if (++fields > 1_024 || !isFieldName(key)) return false;
    if (!fitsConvex((value as Part)[key], depth + 1)) return false;
  }
  return true;
}

function isFieldName(key: string): boolean {
  if (key.length > 1_024 || key.charCodeAt(0) === 36) return false;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 32 || code >= 127) return false;
  }
  return true;
}
