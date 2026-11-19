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

/**
 * The `data.code` of the ConvexError thrown when a save names a
 * `pendingMessageId` whose message is no longer pending (it already
 * succeeded). Use `updateMessage` to change a message that has been filled.
 */
export const PENDING_MESSAGE_NOT_PENDING = "PendingMessageNotPending";

export type PendingMessageNotPendingErrorData = {
  code: typeof PENDING_MESSAGE_NOT_PENDING;
  message: string;
  messageId: string;
  status: string;
};

/**
 * Whether `error` is the ConvexError thrown when saving into a
 * `pendingMessageId` that was already filled. Errors thrown inside the agent
 * component reach the app as a ConvexError with `data` intact.
 */
export function isPendingMessageNotPendingError(
  error: unknown,
): error is Error & { data: PendingMessageNotPendingErrorData } {
  if (!(error instanceof Error)) return false;
  const data = property(error, "data");
  return (
    !!data &&
    typeof data === "object" &&
    property(data, "code") === PENDING_MESSAGE_NOT_PENDING
  );
}
