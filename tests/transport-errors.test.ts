import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APICallError, type LanguageModelV3 } from "@ai-sdk/provider";
import { createAiSdkRuntime } from "../src/ai-sdk.js";
import { createAnthropicRuntime } from "../src/anthropic.js";
import { ModelInvocationError, type ModelInvocationErrorCode, type ModelRuntime } from "../src/index.js";

// Same shape as @anthropic-ai/sdk 0.74 errors: subclasses that never set
// `name` (it stays "Error"), and a socket failure two causes deep behind
// TypeError("fetch failed"), which is what Node's fetch produces.
class APIError extends Error {
  constructor(readonly status: number | undefined, message: string) { super(message); }
}
class APIConnectionError extends APIError {
  constructor(cause?: unknown) { super(undefined, "Connection error."); if (cause) this.cause = cause; }
}
class APIConnectionTimeoutError extends APIConnectionError {}
const fetchFailed = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(`socket ${code}`), { code }) });

// @ai-sdk/provider-utils wraps a failed fetch as a status-less APICallError
// whose cause is the socket error.
const callError = (statusCode: number | undefined, cause?: unknown) => new APICallError({
  message: statusCode === undefined ? "Cannot connect to API" : `HTTP ${String(statusCode)}`,
  url: "https://provider.invalid/v1",
  requestBodyValues: {},
  ...(statusCode === undefined ? {} : { statusCode }),
  ...(cause === undefined ? {} : { cause }),
});

type Expected = [ModelInvocationErrorCode, boolean];
const table: readonly { label: string; anthropic: unknown; aiSdk: unknown; expected: Expected }[] = [
  { label: "HTTP 408", anthropic: new APIError(408, "408"), aiSdk: callError(408), expected: ["PROVIDER_UNAVAILABLE", true] },
  { label: "HTTP 409", anthropic: new APIError(409, "409"), aiSdk: callError(409), expected: ["PROVIDER_UNAVAILABLE", true] },
  { label: "HTTP 400", anthropic: new APIError(400, "400"), aiSdk: callError(400), expected: ["INVALID_REQUEST", false] },
  { label: "HTTP 404", anthropic: new APIError(404, "404"), aiSdk: callError(404), expected: ["INVALID_REQUEST", false] },
  { label: "HTTP 422", anthropic: new APIError(422, "422"), aiSdk: callError(422), expected: ["INVALID_REQUEST", false] },
  { label: "HTTP 401", anthropic: new APIError(401, "401"), aiSdk: callError(401), expected: ["AUTHENTICATION_FAILED", false] },
  { label: "HTTP 429", anthropic: new APIError(429, "429"), aiSdk: callError(429), expected: ["RATE_LIMITED", true] },
  { label: "HTTP 503", anthropic: new APIError(503, "503"), aiSdk: callError(503), expected: ["PROVIDER_UNAVAILABLE", true] },
  {
    label: "client-side request timeout",
    anthropic: new APIConnectionTimeoutError(),
    aiSdk: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    expected: ["PROVIDER_UNAVAILABLE", true],
  },
  { label: "ETIMEDOUT", anthropic: new APIConnectionError(fetchFailed("ETIMEDOUT")), aiSdk: callError(undefined, fetchFailed("ETIMEDOUT").cause), expected: ["PROVIDER_UNAVAILABLE", true] },
  { label: "ECONNRESET", anthropic: new APIConnectionError(fetchFailed("ECONNRESET")), aiSdk: callError(undefined, fetchFailed("ECONNRESET").cause), expected: ["PROVIDER_UNAVAILABLE", true] },
  { label: "ECONNREFUSED", anthropic: new APIConnectionError(fetchFailed("ECONNREFUSED")), aiSdk: callError(undefined, fetchFailed("ECONNREFUSED").cause), expected: ["PROVIDER_UNAVAILABLE", true] },
  { label: "socket closed by peer", anthropic: new APIConnectionError(fetchFailed("UND_ERR_SOCKET")), aiSdk: callError(undefined, fetchFailed("UND_ERR_SOCKET").cause), expected: ["PROVIDER_UNAVAILABLE", true] },
  { label: "unclassifiable error", anthropic: new Error("secret provider body"), aiSdk: new Error("secret provider body"), expected: ["RUNTIME_FAILURE", false] },
  { label: "unmapped HTTP status", anthropic: new APIError(418, "418"), aiSdk: callError(418), expected: ["RUNTIME_FAILURE", false] },
];

const anthropicThrowing = (error: unknown): ModelRuntime =>
  createAnthropicRuntime({ model: "m", client: { async create() { throw error; } } });

const aiSdkThrowing = (error: unknown): ModelRuntime => {
  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "fixture-ai",
    modelId: "fixture-model",
    supportedUrls: {},
    async doGenerate() { throw error; },
    async doStream() { throw error; },
  };
  return createAiSdkRuntime({ model });
};

async function classification(runtime: ModelRuntime): Promise<Expected> {
  try {
    await runtime.invoke({ messages: [{ role: "user", content: "x" }] });
  } catch (error) {
    assert.ok(error instanceof ModelInvocationError);
    assert.doesNotMatch(error.message, /secret/);
    return [error.code, error.retryable];
  }
  assert.fail("invocation did not fail");
}

describe("transport failure classification", () => {
  for (const { label, anthropic, aiSdk, expected } of table) {
    it(`Anthropic runtime: ${label}`, async () => {
      assert.deepEqual(await classification(anthropicThrowing(anthropic)), expected);
    });
    it(`AI SDK runtime: ${label}`, async () => {
      assert.deepEqual(await classification(aiSdkThrowing(aiSdk)), expected);
    });
  }

  it("keeps a caller abort as ABORTED even when the provider reports a transport error", async () => {
    const controller = new AbortController();
    const runtime = aiSdkThrowing(callError(undefined, fetchFailed("ECONNRESET").cause));
    const pending = runtime.invoke({ messages: [{ role: "user", content: "x" }] }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof ModelInvocationError && error.code === "ABORTED");
  });
});
