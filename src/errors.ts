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
// are recognised by constructor name. "TimeoutError" is AbortSignal.timeout().
const transientNames = new Set(["APIConnectionError", "APIConnectionTimeoutError", "TimeoutError"]);
const maxCauseDepth = 3;

function statusOf(error: object): number | undefined {
  for (const key of ["status", "statusCode"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
}

function fromStatus(status: number, error: unknown, fallbackMessage: string): ModelInvocationError {
  if (status === 401 || status === 403) return new ModelInvocationError("AUTHENTICATION_FAILED", "Provider authentication failed", false, { cause: error });
  if (status === 429) return new ModelInvocationError("RATE_LIMITED", "Provider rate limit reached", true, { cause: error });
  if (status === 408 || status === 409 || status >= 500) return new ModelInvocationError("PROVIDER_UNAVAILABLE", "Provider unavailable", true, { cause: error });
  if (status === 400 || status === 404 || status === 422) return new ModelInvocationError("INVALID_REQUEST", "Provider rejected the request", false, { cause: error });
  return new ModelInvocationError("RUNTIME_FAILURE", fallbackMessage, false, { cause: error });
}

/**
 * Classify a provider or framework failure by its HTTP status, error code or
 * error name, looking through a bounded `cause` chain. Anything unrecognised
 * stays RUNTIME_FAILURE / non-retryable.
 */
export function classifyInvocationError(error: unknown, fallbackMessage: string): ModelInvocationError {
  if (error instanceof ModelInvocationError) return error;
  let current: unknown = error;
  for (let depth = 0; depth <= maxCauseDepth && typeof current === "object" && current !== null; depth++) {
    const status = statusOf(current);
    if (status !== undefined) return fromStatus(status, error, fallbackMessage);
    const { code, name } = current as { code?: unknown; name?: unknown };
    if ((typeof code === "string" && transientCodes.has(code))
      || (typeof name === "string" && transientNames.has(name))
      || transientNames.has(current.constructor?.name ?? "")) {
      return new ModelInvocationError("PROVIDER_UNAVAILABLE", "Provider unavailable", true, { cause: error });
    }
    current = (current as { cause?: unknown }).cause;
  }
  return new ModelInvocationError("RUNTIME_FAILURE", fallbackMessage, false, { cause: error });
}
