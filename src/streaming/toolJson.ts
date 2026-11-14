type EncodedToolJson<K extends string = string> = {
  toolJson?: Partial<Record<K, string>>;
};

// Leave ordinary payloads in their existing representation. The sidecar is
// outside user data, so a JSON string or a user field cannot act as a marker.
export function encodeToolJsonFields<T extends object, K extends string>(
  part: T,
  ...keys: K[]
): T & EncodedToolJson<K> {
  let encoded: (T & EncodedToolJson<K>) | undefined;
  for (const key of keys) {
    const value = (part as Record<string, unknown>)[key];
    if (!needsJsonEncoding(value)) continue;
    encoded ??= { ...part, toolJson: {} };
    encoded.toolJson![key] = stringifyToolJson(value);
    Object.assign(encoded, { [key]: null });
  }
  return encoded ?? part;
}

export function decodeToolJsonFields<T extends object>(
  part: T,
  ...keys: string[]
): T {
  const { toolJson } = part as T & EncodedToolJson;
  if (!toolJson) return part;
  const decoded = { ...part } as T & EncodedToolJson;
  delete decoded.toolJson;
  for (const key of keys) {
    if (typeof toolJson[key] === "string") {
      Object.assign(decoded, { [key]: JSON.parse(toolJson[key]) });
    }
  }
  return decoded;
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

function needsJsonEncoding(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 8_192 || value.some(needsJsonEncoding);
  }
  if (value === null || typeof value !== "object") return false;
  const entries = Object.entries(value);
  return (
    entries.length > 1_024 ||
    entries.some(
      ([key, child]) =>
        key.length === 0 ||
        key.length > 1_024 ||
        key.startsWith("$") ||
        /[^ -~]/.test(key) ||
        needsJsonEncoding(child),
    )
  );
}

// Use stable key order for approval comparisons and keep -0 distinct. Values
// outside JSON may still travel natively when they meet Convex's field limits.
function stringifyToolJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Object.is(value, -0) ? "-0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, stringifyToolJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null || Object.getPrototypeOf(prototype) === null) {
      const entries = Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(
          ([key, child]) =>
            `${JSON.stringify(key)}:${stringifyToolJson(child)}`,
        );
      return `{${entries.join(",")}}`;
    }
  }
  throw new Error(
    "Tool payloads outside Convex field limits must be JSON values",
  );
}
