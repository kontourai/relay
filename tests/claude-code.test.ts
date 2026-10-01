import assert from "node:assert/strict";
import test from "node:test";
import { detectUsageLimit } from "../src/harness-text.js";
import { incidentalAuthStderr, priorRateLimitStderr } from "./stderr-fixtures.js";
import { createClaudeCodeCodec } from "../src/claude-code.js";
import { ModelInvocationError, type ModelInvocationRequest } from "../src/types.js";

const request: ModelInvocationRequest = {
  messages: [
    { role: "system", content: "Extract without deciding truth." },
    { role: "user", content: "Camp Alpha has 40 openings." },
  ],
  tools: [{
    name: "submit",
    description: "Submit extracted values",
    inputSchema: { type: "object", properties: { openings: { type: "number" } }, required: ["openings"] },
  }],
  toolChoice: { type: "tool", name: "submit" },
  maxOutputTokens: 3,
};

test("Claude Code profile projects one forced tool through native JSON schema", () => {
  const codec = createClaudeCodeCodec("sonnet");
  const invocation = codec.prepare(request);
  assert.deepEqual(invocation.args.slice(0, 6), ["--print", "--output-format", "json", "--model", "sonnet", "--no-session-persistence"]);
  const schemaIndex = invocation.args.indexOf("--json-schema");
  assert.ok(schemaIndex > 0);
  assert.deepEqual(JSON.parse(invocation.args[schemaIndex + 1]!), request.tools?.[0]?.inputSchema);
  assert.match(invocation.stdin ?? "", /Camp Alpha/);

  const result = codec.parse({
    stdout: JSON.stringify({
      result: "",
      structured_output: { openings: 40 },
      usage: {
        input_tokens: 8,
        output_tokens: 4,
        cache_read_input_tokens: 120,
        cache_creation_input_tokens: 16,
      },
      total_cost_usd: 0.0042,
      stop_reason: "end_turn",
    }),
    stderr: "",
    exitCode: 0,
    latencyMs: 12,
  }, request);
  assert.deepEqual(result.toolCalls, [{ id: "claude-code-structured-output", name: "submit", input: { openings: 40 } }]);
  // No modelUsage in this result, so the configured model is echoed and labelled as such.
  assert.deepEqual([result.model, result.modelSource], ["sonnet", "configured"]);
  assert.deepEqual(result.usage, {
    inputTokens: 8,
    outputTokens: 4,
    totalTokens: 12,
    cacheReadTokens: 120,
    cacheWriteTokens: 16,
    costUsd: 0.0042,
  });
  assert.deepEqual(result.warnings, ["OUTPUT_TOKEN_LIMIT_NOT_ENFORCED: requested 3, observed 4"]);
});

test("Claude Code declares that output-token requests are not enforced", async () => {
  const { createClaudeCodeRuntime } = await import("../src/claude-code.js");
  assert.equal(
    createClaudeCodeRuntime({ model: "sonnet" }).capabilities().outputTokenLimitFidelity,
    "unavailable",
  );
});

test("Claude Code profile rejects tool semantics its CLI cannot guarantee", () => {
  const codec = createClaudeCodeCodec("sonnet");
  assert.throws(() => codec.prepare({ ...request, toolChoice: { type: "auto" } }), (error: unknown) =>
    error instanceof ModelInvocationError && error.code === "INVALID_REQUEST");
});

test("Claude Code profile classifies failures without returning stderr", () => {
  const marker = "credential private-marker";
  const error = createClaudeCodeCodec("sonnet").classifyFailure?.({
    stdout: "",
    stderr: marker,
    exitCode: 1,
    latencyMs: 1,
  }, request);
  assert.equal(error?.code, "AUTHENTICATION_FAILED");
  assert.doesNotMatch(error?.message ?? "", /private-marker/);
});

test("Claude Code profile rejects a successful response missing forced structured output", () => {
  const codec = createClaudeCodeCodec("sonnet");
  assert.throws(() => codec.parse({
    stdout: JSON.stringify({ result: "unstructured" }),
    stderr: "",
    exitCode: 0,
    latencyMs: 1,
  }, request), (error: unknown) => error instanceof ModelInvocationError && error.code === "RUNTIME_FAILURE");
});

test("Claude Code reports the served model only when modelUsage names exactly one", () => {
  const codec = createClaudeCodeCodec("haiku");
  const plain = { messages: [{ role: "user" as const, content: "x" }] };
  // Entry shape as the CLI writes it (keys trimmed); the key is the served model id.
  const usageEntry = { inputTokens: 9, outputTokens: 43, costUSD: 0.008, canonicalModel: "claude-haiku-4-5" };
  const parse = (modelUsage: unknown) => codec.parse({
    stdout: JSON.stringify({ result: "ok", is_error: false, stop_reason: "end_turn", modelUsage }),
    stderr: "", exitCode: 0, latencyMs: 1,
  }, plain);
  const single = parse({ "claude-haiku-4-5-20251001": usageEntry });
  assert.deepEqual([single.model, single.modelSource], ["claude-haiku-4-5-20251001", "provider-reported"]);
  const several = parse({ "claude-haiku-4-5-20251001": usageEntry, "claude-sonnet-4-5-20250929": usageEntry });
  assert.deepEqual([several.model, several.modelSource], ["haiku", "configured"]);
  const empty = parse({});
  assert.deepEqual([empty.model, empty.modelSource], ["haiku", "configured"]);
});

const describedRequest: ModelInvocationRequest = {
  messages: [{ role: "user", content: "Camp Alpha has 40 openings." }],
  tools: [{
    name: "submit",
    description: "Report openings exactly as written.",
    inputSchema: { type: "object", properties: { openings: { type: "number", description: "Seats still open." } }, required: ["openings"] },
  }],
  toolChoice: { type: "tool", name: "submit" },
};

test("Claude Code prompt carries the tool description and field descriptions", () => {
  const invocation = createClaudeCodeCodec("sonnet").prepare(describedRequest);
  assert.equal(invocation.stdin, [
    "Process the following provider-neutral conversation. Preserve the roles and return only the requested response.",
    "Description of the submit result:\nReport openings exactly as written.",
    "Field descriptions for the submit result:\n- openings: Seats still open.",
    "{\"messages\":[{\"role\":\"user\",\"content\":\"Camp Alpha has 40 openings.\"}]}",
  ].join("\n\n"));
  assert.deepEqual(invocation.args, [
    "--print", "--output-format", "json", "--model", "sonnet", "--no-session-persistence", "--tools", "", "--permission-mode", "dontAsk",
    "--json-schema", "{\"type\":\"object\",\"properties\":{\"openings\":{\"type\":\"number\",\"description\":\"Seats still open.\"}},\"required\":[\"openings\"]}",
  ]);
});

// The stdout the CLI printed for a usage-limit run (exit code 1, empty stderr),
// trimmed to the keys the profile reads.
const limitStdout = JSON.stringify({
  type: "result", subtype: "success", is_error: true, api_error_status: 429, terminal_reason: "api_error",
  result: "You've hit your session limit · resets 5pm (America/Denver)", modelUsage: {}, total_cost_usd: 0,
});

test("Claude Code classifies its usage-limit result as a retryable rate limit with a reason", () => {
  const codec = createClaudeCodeCodec("sonnet");
  const error = codec.classifyFailure?.({ stdout: limitStdout, stderr: "", exitCode: 1, latencyMs: 1 }, request);
  assert.deepEqual([error?.code, error?.message, error?.retryable], ["RATE_LIMITED", "Claude Code rate limited: session limit reached; resets 5pm", true]);
  // The same result with a zero exit code must not read as a generic failure either.
  assert.throws(() => codec.parse({ stdout: limitStdout, stderr: "", exitCode: 0, latencyMs: 1 }, request), (thrown: unknown) =>
    thrown instanceof ModelInvocationError && thrown.code === "RATE_LIMITED" && thrown.retryable);
  const statusOnly = codec.classifyFailure?.({
    stdout: JSON.stringify({ is_error: true, api_error_status: 429, result: "API Error: /Users/someone/private sk-live-PRIVATE" }),
    stderr: "", exitCode: 1, latencyMs: 1,
  }, request);
  assert.deepEqual([statusOnly?.code, statusOnly?.message, statusOnly?.retryable], ["RATE_LIMITED", "Claude Code rate limited: rate limit reached", true]);
});

test("Claude Code does not read a limit from a successful response or an unrelated failure", () => {
  const codec = createClaudeCodeCodec("sonnet");
  const plain = { messages: [{ role: "user" as const, content: "x" }] };
  const result = codec.parse({
    stdout: JSON.stringify({ result: "You've hit your weekly limit", is_error: false }), stderr: "", exitCode: 0, latencyMs: 1,
  }, plain);
  assert.equal(result.outputText, "You've hit your weekly limit");
  const other = codec.classifyFailure?.({
    stdout: JSON.stringify({ result: "You've hit your weekly limit", is_error: false }), stderr: "boom", exitCode: 1, latencyMs: 1,
  }, plain);
  assert.deepEqual([other?.code, other?.message], ["RUNTIME_FAILURE", "Claude Code failed with exit code 1"]);
  // A status on a result that is not an error says nothing about why the process exited.
  for (const api_error_status of [401, 429]) {
    const stale = codec.classifyFailure?.({
      stdout: JSON.stringify({ result: "ok", is_error: false, api_error_status }), stderr: "boom", exitCode: 1, latencyMs: 1,
    }, plain);
    assert.deepEqual([stale?.code, stale?.message], ["RUNTIME_FAILURE", "Claude Code failed with exit code 1"]);
  }
});

test("Claude Code keeps classifying every stderr rate-limit line it classified before", () => {
  const codec = createClaudeCodeCodec("sonnet");
  for (const stderr of priorRateLimitStderr) {
    const error = codec.classifyFailure?.({ stdout: "", stderr, exitCode: 1, latencyMs: 1 }, request);
    assert.deepEqual([error?.code, error?.message, error?.retryable], ["RATE_LIMITED", "Claude Code rate limited: rate limit reached", true], stderr);
  }
});

test("Claude Code reports an authentication failure when stderr also mentions a limit", () => {
  const codec = createClaudeCodeCodec("sonnet");
  // The last line really does match a limit, so this fails if the limit check runs first.
  const both = "Authentication failed: invalid api key. usage limit reached, try again at 9:05 PM.";
  assert.equal(detectUsageLimit([both]), "usage limit reached; resets 9:05 PM");
  for (const stderr of [
    "Error: not logged in. Run login. (See rate limits at https://example.test/limits)",
    "401 Unauthorized: invalid api key. usage limit info unavailable",
    both,
  ]) {
    const error = codec.classifyFailure?.({ stdout: "", stderr, exitCode: 1, latencyMs: 1 }, request);
    assert.deepEqual([error?.code, error?.retryable], ["AUTHENTICATION_FAILED", false], stderr);
    // A failed run that exits zero is classified the same way.
    assert.throws(() => codec.parse({ stdout: JSON.stringify({ is_error: true, result: "failed" }), stderr, exitCode: 0, latencyMs: 1 }, request), (thrown: unknown) =>
      thrown instanceof ModelInvocationError && thrown.code === "AUTHENTICATION_FAILED", stderr);
  }
});

test("Claude Code trusts its structured limit report over auth-looking stderr noise", () => {
  const codec = createClaudeCodeCodec("sonnet");
  for (const stderr of [...incidentalAuthStderr, "Error: not logged in. Run login."]) {
    const error = codec.classifyFailure?.({ stdout: limitStdout, stderr, exitCode: 1, latencyMs: 1 }, request);
    assert.deepEqual([error?.code, error?.message, error?.retryable], ["RATE_LIMITED", "Claude Code rate limited: session limit reached; resets 5pm", true], stderr);
    assert.throws(() => codec.parse({ stdout: limitStdout, stderr, exitCode: 0, latencyMs: 1 }, request), (thrown: unknown) =>
      thrown instanceof ModelInvocationError && thrown.code === "RATE_LIMITED" && thrown.retryable, stderr);
  }
});

test("Claude Code reads a limit from stderr when the run printed no result", () => {
  const error = createClaudeCodeCodec("sonnet").classifyFailure?.({
    stdout: "", stderr: "You've hit your weekly limit · resets Oct 4", exitCode: 1, latencyMs: 1,
  }, request);
  assert.deepEqual([error?.code, error?.message, error?.retryable],
    ["RATE_LIMITED", "Claude Code rate limited: weekly limit reached; resets Oct 4", true]);
});

test("Claude Code treats an error result with an authentication status as an authentication failure", () => {
  const codec = createClaudeCodeCodec("sonnet");
  for (const status of [401, 403]) {
    const stdout = JSON.stringify({ is_error: true, api_error_status: status, result: "Invalid API key · usage limit reached, try again at 9:05 PM" });
    const error = codec.classifyFailure?.({ stdout, stderr: "", exitCode: 1, latencyMs: 1 }, request);
    assert.deepEqual([error?.code, error?.retryable], ["AUTHENTICATION_FAILED", false], String(status));
    assert.throws(() => codec.parse({ stdout, stderr: "", exitCode: 0, latencyMs: 1 }, request), (thrown: unknown) =>
      thrown instanceof ModelInvocationError && thrown.code === "AUTHENTICATION_FAILED", String(status));
  }
});
