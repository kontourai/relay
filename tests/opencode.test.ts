import assert from "node:assert/strict";
import test from "node:test";
import { detectUsageLimit } from "../src/harness-text.js";
import { incidentalAuthStderr, priorRateLimitStderr } from "./stderr-fixtures.js";
import { createOpenCodeCodec, createOpenCodeRuntime } from "../src/opencode.js";
import { ModelInvocationError, type ModelInvocationRequest } from "../src/types.js";

const request: ModelInvocationRequest = {
  messages: [{ role: "user", content: "Camp Alpha has 40 openings." }],
  tools: [{ name: "submit", inputSchema: { type: "object", properties: { openings: { type: "number" } }, required: ["openings"] } }],
  toolChoice: { type: "tool", name: "submit" },
};

test("OpenCode defaults to rejecting structured tools honestly", () => {
  const runtime = createOpenCodeRuntime({ model: "zai/glm-5" });
  assert.deepEqual(runtime.capabilities(), {
    structuredTools: false,
    structuredToolsFidelity: "unavailable",
    outputTokenLimitFidelity: "unavailable",
    streaming: false,
    abort: true,
    usage: true,
  });
  assert.throws(() => createOpenCodeCodec("zai/glm-5").prepare(request), (error: unknown) =>
    error instanceof ModelInvocationError && error.code === "INVALID_REQUEST");
});

test("OpenCode prompted mode projects JSON events with an explicit fidelity warning", () => {
  const codec = createOpenCodeCodec("zai/glm-5", "prompted");
  const invocation = codec.prepare(request);
  assert.deepEqual(invocation.args, ["--pure", "run", "--format", "json", "--model", "zai/glm-5"]);
  assert.match(invocation.stdin ?? "", /Return only JSON matching this schema/);
  const result = codec.parse({
    stdout: [
      JSON.stringify({ type: "text", part: { type: "text", text: "{\"openings\":40}" } }),
      JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "stop", tokens: { input: 7, output: 3 } } }),
    ].join("\n"),
    stderr: "",
    exitCode: 0,
    latencyMs: 10,
  }, request);
  assert.deepEqual(result.toolCalls, [{ id: "opencode-prompted-output", name: "submit", input: { openings: 40 } }]);
  assert.deepEqual([result.model, result.modelSource], ["zai/glm-5", "configured"]);
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  assert.match(result.warnings?.[0] ?? "", /prompt-enforced/);
});

test("OpenCode prompted mode marks malformed model JSON retryable", () => {
  const codec = createOpenCodeCodec("zai/glm-5", "prompted");
  assert.throws(() => codec.parse({
    stdout: JSON.stringify({ type: "text", part: { type: "text", text: "not-json" } }),
    stderr: "",
    exitCode: 0,
    latencyMs: 1,
  }, request), (error: unknown) => error instanceof ModelInvocationError && error.code === "RUNTIME_FAILURE" && error.retryable);
});

test("OpenCode prompted prompt carries the tool description and field descriptions", () => {
  const schema = { type: "object", properties: { openings: { type: "number", description: "Seats still open." } }, required: ["openings"] };
  const invocation = createOpenCodeCodec("zai/glm-5", "prompted").prepare({
    messages: request.messages,
    tools: [{ name: "submit", description: "Report openings exactly as written.", inputSchema: schema }],
    toolChoice: { type: "tool", name: "submit" },
  });
  assert.equal(invocation.stdin, [
    "Process the following provider-neutral conversation. Preserve the roles and return only the requested response.",
    "Return only JSON matching this schema for the submit result. Do not use a Markdown fence.",
    "{\"type\":\"object\",\"properties\":{\"openings\":{\"type\":\"number\",\"description\":\"Seats still open.\"}},\"required\":[\"openings\"]}",
    "Description of the submit result:\nReport openings exactly as written.",
    "Field descriptions for the submit result:\n- openings: Seats still open.",
    "{\"messages\":[{\"role\":\"user\",\"content\":\"Camp Alpha has 40 openings.\"}]}",
  ].join("\n\n"));
});

test("OpenCode classifies a usage-limit error event as a retryable rate limit with a reason", () => {
  const codec = createOpenCodeCodec("zai/glm-5");
  const plain = { messages: request.messages };
  // Error-event shape as \`opencode run --format json\` prints it (exit code 1).
  const stdout = JSON.stringify({
    type: "error", timestamp: 1, sessionID: "ses_fixture",
    error: { name: "APIError", data: { message: "Go usage limit reached. It will reset in 2 days 3 hours. To continue using this model now, enable usage from your available balance - https://opencode.ai/workspace/wrk_fixture/go" } },
  });
  const error = codec.classifyFailure?.({ stdout, stderr: "", exitCode: 1, latencyMs: 1 }, plain);
  assert.deepEqual([error?.code, error?.message, error?.retryable],
    ["RATE_LIMITED", "OpenCode rate limited: usage limit reached; resets in 2 days 3 hours", true]);
  assert.throws(() => codec.parse({ stdout, stderr: "", exitCode: 0, latencyMs: 1 }, plain), (thrown: unknown) =>
    thrown instanceof ModelInvocationError && thrown.code === "RATE_LIMITED" && thrown.retryable);
  const stderrOnly = codec.classifyFailure?.({ stdout: "", stderr: "Error: Too Many Requests", exitCode: 1, latencyMs: 1 }, plain);
  assert.deepEqual([stderrOnly?.code, stderrOnly?.message, stderrOnly?.retryable], ["RATE_LIMITED", "OpenCode rate limited: rate limit reached", true]);
  const text = codec.classifyFailure?.({
    stdout: JSON.stringify({ type: "text", part: { type: "text", text: "usage limit reached" } }), stderr: "", exitCode: 1, latencyMs: 1,
  }, plain);
  assert.deepEqual([text?.code, text?.message], ["RUNTIME_FAILURE", "OpenCode failed with exit code 1"]);
});

test("OpenCode keeps classifying every stderr rate-limit line it classified before", () => {
  const codec = createOpenCodeCodec("zai/glm-5");
  for (const stderr of priorRateLimitStderr) {
    const error = codec.classifyFailure?.({ stdout: "", stderr, exitCode: 1, latencyMs: 1 }, { messages: request.messages });
    assert.deepEqual([error?.code, error?.message, error?.retryable], ["RATE_LIMITED", "OpenCode rate limited: rate limit reached", true], stderr);
  }
});

test("OpenCode reports an authentication failure when stderr also mentions a limit", () => {
  const codec = createOpenCodeCodec("zai/glm-5");
  // The last line really does match a limit, so this fails if the limit check runs first.
  const both = "Authentication failed: invalid api key. usage limit reached, try again at 9:05 PM.";
  assert.equal(detectUsageLimit([both]), "usage limit reached; resets 9:05 PM");
  for (const stderr of [
    "Error: not logged in. Run login. (See rate limits at https://example.test/limits)",
    "401 Unauthorized: invalid api key. usage limit info unavailable",
    both,
  ]) {
    const error = codec.classifyFailure?.({ stdout: "", stderr, exitCode: 1, latencyMs: 1 }, { messages: request.messages });
    assert.deepEqual([error?.code, error?.retryable], ["AUTHENTICATION_FAILED", false], stderr);
    // A failed run that exits zero is classified the same way.
    assert.throws(() => codec.parse({ stdout: "", stderr, exitCode: 0, latencyMs: 1 }, { messages: request.messages }), (thrown: unknown) =>
      thrown instanceof ModelInvocationError && thrown.code === "AUTHENTICATION_FAILED", stderr);
  }
});

test("OpenCode trusts its structured limit report over auth-looking stderr noise", () => {
  const codec = createOpenCodeCodec("zai/glm-5");
  for (const stderr of [...incidentalAuthStderr, "Error: not logged in. Run login."]) {
    const error = codec.classifyFailure?.({ stdout: JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "Go usage limit reached. It will reset in 2 days 3 hours." } } }), stderr, exitCode: 1, latencyMs: 1 }, { messages: request.messages });
    assert.deepEqual([error?.code, error?.message, error?.retryable], ["RATE_LIMITED", "OpenCode rate limited: usage limit reached; resets in 2 days 3 hours", true], stderr);
    assert.throws(() => codec.parse({ stdout: JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "Go usage limit reached. It will reset in 2 days 3 hours." } } }), stderr, exitCode: 0, latencyMs: 1 }, { messages: request.messages }), (thrown: unknown) =>
      thrown instanceof ModelInvocationError && thrown.code === "RATE_LIMITED" && thrown.retryable, stderr);
  }
});

test("OpenCode reads a limit from each text field of an error event", () => {
  const codec = createOpenCodeCodec("zai/glm-5");
  const plain = { messages: request.messages };
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ name: "FreeUsageLimitError" }, "free usage limit reached"],
    [{ name: "UnknownError", message: "Go usage limit reached." }, "usage limit reached"],
    [{ name: "APIError", data: { message: "You exceeded your current quota." } }, "quota exhausted"],
    [{ name: "APIError", data: { message: "Provider error", responseBody: "{\"error\":{\"type\":\"usage_limit_reached\"}}" } }, "usage limit reached"],
  ];
  for (const [error, reason] of cases) {
    const classified = codec.classifyFailure?.({ stdout: JSON.stringify({ type: "error", error }), stderr: "", exitCode: 1, latencyMs: 1 }, plain);
    assert.deepEqual([classified?.code, classified?.message], ["RATE_LIMITED", `OpenCode rate limited: ${reason}`], JSON.stringify(error));
  }
});

test("OpenCode reads the provider status of an error event", () => {
  const codec = createOpenCodeCodec("zai/glm-5");
  const plain = { messages: request.messages };
  // APIError data as opencode declares it: message, optional statusCode, isRetryable, optional responseBody.
  const event = (statusCode: number, message: string) =>
    JSON.stringify({ type: "error", error: { name: "APIError", data: { message, statusCode, isRetryable: false } } });
  const limited = codec.classifyFailure?.({ stdout: event(429, "Provider error"), stderr: "", exitCode: 1, latencyMs: 1 }, plain);
  assert.deepEqual([limited?.code, limited?.message, limited?.retryable], ["RATE_LIMITED", "OpenCode rate limited: rate limit reached", true]);
  for (const status of [401, 403]) {
    const denied = codec.classifyFailure?.({ stdout: event(status, "Invalid key. usage limit reached."), stderr: "", exitCode: 1, latencyMs: 1 }, plain);
    assert.deepEqual([denied?.code, denied?.retryable], ["AUTHENTICATION_FAILED", false], String(status));
  }
  const other = codec.classifyFailure?.({ stdout: event(500, "Provider error"), stderr: "", exitCode: 1, latencyMs: 1 }, plain);
  assert.equal(other?.code, "RUNTIME_FAILURE");
});
