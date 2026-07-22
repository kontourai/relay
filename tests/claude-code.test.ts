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
      usage: { input_tokens: 8, output_tokens: 4 },
      stop_reason: "end_turn",
    }),
    stderr: "",
    exitCode: 0,
    latencyMs: 12,
  }, request);
  assert.deepEqual(result.toolCalls, [{ id: "claude-code-structured-output", name: "submit", input: { openings: 40 } }]);
  assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 4, totalTokens: 12 });
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
