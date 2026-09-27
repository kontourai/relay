import { ModelInvocationError } from "./types.js";

// Transport failures that carry no HTTP status. Node's fetch (undici) puts the
// socket code two causes deep: SDK error -> TypeError("fetch failed") -> code.
const transientCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
// The Anthropic SDK does not set `name` on its errors, so its connection errors
// are recognised by constructor name.
const transientConstructors = new Set(["APIConnectionError", "APIConnectionTimeoutError"]);
const maxCauseDepth = 3;

// `status` (Anthropic SDK, fetch) or `statusCode` (AI SDK), as a number or a
// numeric string such as "503".
function statusOf(error: object): number | undefined {
  for (const key of ["status", "statusCode"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  }
  return undefined;
}

// AbortSignal.timeout() rejects with a DOMException named "TimeoutError". Other
// classes that happen to be named TimeoutError are not trusted.
function isAbortSignalTimeout(error: object): boolean {
  return typeof DOMException === "function" && error instanceof DOMException && error.name === "TimeoutError";
}

function fromStatus(status: number, error: unknown, fallbackMessage: string): ModelInvocationError {
  if (status === 401 || status === 403) return new ModelInvocationError("AUTHENTICATION_FAILED", "Provider authentication failed", false, { cause: error });
  if (status === 429) return new ModelInvocationError("RATE_LIMITED", "Provider rate limit reached", true, { cause: error });
  // 501 Not Implemented will not change on retry; other 5xx are transient.
  if (status === 408 || status === 409 || (status >= 500 && status <= 599 && status !== 501)) return new ModelInvocationError("PROVIDER_UNAVAILABLE", "Provider unavailable", true, { cause: error });
  if (status === 400 || status === 404 || status === 422) return new ModelInvocationError("INVALID_REQUEST", "Provider rejected the request", false, { cause: error });
  return new ModelInvocationError("RUNTIME_FAILURE", fallbackMessage, false, { cause: error });
}

/**
 * Classify a provider or framework failure by its HTTP status, socket error
 * code, the AI SDK's `isRetryable` flag, an AbortSignal timeout, or an
 * Anthropic SDK connection-error class, looking through up to three levels of
 * `cause`. Anything unrecognised
 * stays RUNTIME_FAILURE / non-retryable.
 */
export function classifyInvocationError(error: unknown, fallbackMessage: string): ModelInvocationError {
  if (error instanceof ModelInvocationError) return error;
  let current: unknown = error;
  for (let depth = 0; depth <= maxCauseDepth && typeof current === "object" && current !== null; depth++) {
    const status = statusOf(current);
    if (status !== undefined) return fromStatus(status, error, fallbackMessage);
    const { code, isRetryable } = current as { code?: unknown; isRetryable?: unknown };
    if ((typeof code === "string" && transientCodes.has(code))
      || isRetryable === true // the AI SDK's own verdict on a status-less APICallError
      || isAbortSignalTimeout(current)
      || transientConstructors.has(current.constructor?.name ?? "")) {
      return new ModelInvocationError("PROVIDER_UNAVAILABLE", "Provider unavailable", true, { cause: error });
    }
    current = (current as { cause?: unknown }).cause;
  }
  return new ModelInvocationError("RUNTIME_FAILURE", fallbackMessage, false, { cause: error });
}
