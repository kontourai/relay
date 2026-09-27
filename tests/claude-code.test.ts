import assert from "node:assert/strict";
import test from "node:test";
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
