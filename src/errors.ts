const MAX_ERROR_LENGTH = 1024;

export function errorToString(error: unknown): string {
  return truncateError(describeError(error));
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const message = property(error, "message");
    if (typeof message !== "string" || message.length === 0) {
      const name = property(error, "name");
      return typeof name === "string" && name.length > 0
        ? name
        : safeString(error);
    }
    const nested = errorDetails(
      property(error, "error") ?? property(error, "data"),
    );
    return (
      formatDetails({
        message: nested.message ?? message,
        code: nested.code,
      }) ?? message
    );
  }

  const details = formatDetails(errorDetails(error));
  if (details) return details;

  if (error && typeof error === "object") {
    try {
      const ancestors: object[] = [];
      const serialized = JSON.stringify(error, function (_key, value: unknown) {
        if (typeof value === "bigint") return value.toString();
        if (!value || typeof value !== "object") return value;
        while (ancestors.length > 0 && ancestors.at(-1) !== this) {
          ancestors.pop();
        }
        if (ancestors.includes(value)) return "[Circular]";
        ancestors.push(value);
        return value;
      });
      if (serialized) return serialized;
    } catch {
      return safeString(error);
    }
  }

  return safeString(error);
}

function safeString(error: unknown): string {
  try {
    return String(error);
  } catch {
    return "Unknown error";
  }
}

function errorDetails(error: unknown): { message?: string; code?: string } {
  let current = error;
  let message: string | undefined;
  let code: string | undefined;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof current === "string") {
      message ??= current;
      break;
    }
    if (!current || typeof current !== "object") break;

    const currentMessage = property(current, "message");
    if (typeof currentMessage === "string" && currentMessage.length > 0) {
      message ??= currentMessage;
    }
    const currentCode = property(current, "code");
    if (typeof currentCode === "string" || typeof currentCode === "number") {
      code ??= String(currentCode);
    }
    if (message && code) break;
    current = property(current, "error") ?? property(current, "data");
  }
  return { message, code };
}

function property(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function formatDetails({
  message,
  code,
}: {
  message?: string;
  code?: string;
}): string | undefined {
  if (message && code) {
    return message.startsWith(`${code}:`) ? message : `${code}: ${message}`;
  }
  return message ?? code;
}

function truncateError(error: string): string {
  if (error.length <= MAX_ERROR_LENGTH) return error;
  let truncated = error.slice(0, MAX_ERROR_LENGTH - 1);
  const last = truncated.charCodeAt(truncated.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) truncated = truncated.slice(0, -1);
  return `${truncated}…`;
}

const refusedMarker = Symbol.for("@convex-dev/agent/ModelCallRefusedError");

/**
 * Throw this from language model middleware (see `languageModelMiddleware`)
 * to refuse a model call, for example when a user is over budget.
 *
 * The generation saves nothing for the refused step: the pending placeholder
 * message is deleted, and steps that already finished stay saved. The error
 * is rethrown from `generateText` and the other generation methods, so the
 * caller can catch it and save its own reply.
 */
export class ModelCallRefusedError extends Error {
  readonly [refusedMarker] = true;
  /** App-defined details, e.g. which limit was hit. */
  readonly data?: unknown;

  constructor(
    message = "Model call refused",
    options?: { data?: unknown; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ModelCallRefusedError";
    this.data = options?.data;
  }

  /** Works across copies of this package, unlike `instanceof`. */
  static isInstance(error: unknown): error is ModelCallRefusedError {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[refusedMarker] === true
    );
  }
}
