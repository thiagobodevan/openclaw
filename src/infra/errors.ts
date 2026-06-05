// Normalizes error objects for codes, names, messages, and redacted logs.
import { redactSensitiveText } from "../logging/redact.js";

function isObjectLike(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function readErrorField(err: unknown, key: PropertyKey): unknown {
  if (!isObjectLike(err)) {
    return undefined;
  }
  try {
    return err[key];
  } catch {
    return undefined;
  }
}

function isErrorInstance(err: unknown): err is Error {
  try {
    return err instanceof Error;
  } catch {
    return false;
  }
}

function formatUnknownObject(value: unknown): string {
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "Unknown error";
    }
  }
}

function copyEnumerableDataFields(
  value: Record<PropertyKey, unknown>,
): Record<PropertyKey, unknown> {
  const copy: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      throw new Error("error field descriptor disappeared");
    }
    if (!descriptor.enumerable) {
      continue;
    }
    if (!("value" in descriptor)) {
      throw new Error("error field accessor is not safe to copy");
    }
    if (key === "cause") {
      continue;
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

export function extractErrorCode(err: unknown): string | undefined {
  const code = readErrorField(err, "code");
  if (typeof code === "string") {
    return code;
  }
  if (typeof code === "number") {
    return String(code);
  }
  return undefined;
}

export function readErrorName(err: unknown): string {
  const name = readErrorField(err, "name");
  return typeof name === "string" ? name : "";
}

export function collectErrorGraphCandidates(
  err: unknown,
  resolveNested?: (current: Record<string, unknown>) => Iterable<unknown>,
): unknown[] {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    candidates.push(current);

    if (!isObjectLike(current) || !resolveNested) {
      continue;
    }
    try {
      for (const nested of resolveNested(current as Record<string, unknown>)) {
        if (nested != null && !seen.has(nested)) {
          queue.push(nested);
        }
      }
    } catch {
      continue;
    }
  }

  return candidates;
}

/**
 * Type guard for NodeJS.ErrnoException (any error with a `code` property).
 */
export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return readErrorField(err, "code") !== undefined;
}

/**
 * Check if an error has a specific errno code.
 */
export function hasErrnoCode(err: unknown, code: string): boolean {
  return extractErrorCode(err) === code;
}

export function formatErrorMessage(err: unknown): string {
  let formatted: string;
  if (isErrorInstance(err)) {
    const message = readErrorField(err, "message");
    const name = readErrorField(err, "name");
    formatted =
      (typeof message === "string" && message) || (typeof name === "string" && name) || "Error";
    // Traverse .cause chain to include nested error messages (e.g. grammY HttpError wraps network errors in .cause)
    let cause: unknown = readErrorField(err, "cause");
    const seen = new Set<unknown>([err]);
    // Skip causes that repeat a message already emitted (e.g. coerceToFailoverError).
    const seenMessages = new Set<string>([formatted]);
    const appendCauseMessage = (causeText: string): void => {
      if (!causeText || seenMessages.has(causeText)) {
        return;
      }
      formatted += ` | ${causeText}`;
      seenMessages.add(causeText);
    };
    while (cause && !seen.has(cause)) {
      seen.add(cause);
      if (isErrorInstance(cause)) {
        const causeMessage = readErrorField(cause, "message");
        if (typeof causeMessage === "string") {
          appendCauseMessage(causeMessage);
        }
        cause = readErrorField(cause, "cause");
      } else if (typeof cause === "string") {
        appendCauseMessage(cause);
        break;
      } else {
        break;
      }
    }
  } else if (typeof err === "string") {
    formatted = err;
  } else if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    formatted = String(err);
  } else {
    formatted = formatUnknownObject(err);
  }
  // Security: best-effort token redaction before returning/logging.
  return redactSensitiveText(formatted);
}

/**
 * Render a non-Error `cause` value (string, number, plain object, etc.) for inclusion in
 * a flattened error chain. Returns `[object Object]`-free text without throwing.
 */
export function stringifyNonErrorCause(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return formatUnknownObject(value);
}

export function toErrorObject(value: unknown, fallbackMessage: string): Error {
  if (isErrorInstance(value)) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage);
  if (isObjectLike(value)) {
    try {
      const fields = copyEnumerableDataFields(value);
      Object.assign(error, fields);
    } catch {
      // Hostile thrown values should not replace the fallback Error while normalizing.
    }
  }
  return error;
}

export function formatUncaughtError(err: unknown): string {
  if (extractErrorCode(err) === "INVALID_CONFIG") {
    return formatErrorMessage(err);
  }
  if (isErrorInstance(err)) {
    const stack = readErrorField(err, "stack");
    const message = readErrorField(err, "message");
    const name = readErrorField(err, "name");
    const formatted =
      (typeof stack === "string" && stack) ||
      (typeof message === "string" && message) ||
      (typeof name === "string" && name) ||
      "Error";
    return redactSensitiveText(formatted);
  }
  return formatErrorMessage(err);
}

export type ErrorKind = "refusal" | "timeout" | "rate_limit" | "context_length" | "unknown";

export function detectErrorKind(err: unknown): ErrorKind | undefined {
  if (err === undefined) {
    return undefined;
  }
  const message = formatErrorMessage(err).toLowerCase();
  const code = extractErrorCode(err)?.toLowerCase();

  if (
    message.includes("refusal") ||
    message.includes("content_filter") ||
    message.includes("sensitive") ||
    message.includes("unhandled stop reason: refusal_policy")
  ) {
    return "refusal";
  }
  if (message.includes("timeout") || code === "etimedout" || code === "timeout") {
    return "timeout";
  }
  if (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("429") ||
    code === "429"
  ) {
    return "rate_limit";
  }
  if (
    message.includes("context length") ||
    message.includes("too many tokens") ||
    message.includes("token limit") ||
    message.includes("context_window")
  ) {
    return "context_length";
  }
  return undefined;
}
