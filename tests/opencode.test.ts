import assert from "node:assert/strict";
import test from "node:test";
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

test("OpenCode classifies a usage-limit error event as a non-retryable rate limit with a reason", () => {
  const codec = createOpenCodeCodec("zai/glm-5");
  const plain = { messages: request.messages };
  // Error-event shape as \`opencode run --format json\` prints it (exit code 1).
  const stdout = JSON.stringify({
    type: "error", timestamp: 1, sessionID: "ses_fixture",
    error: { name: "APIError", data: { message: "Go usage limit reached. It will reset in 2 days 3 hours. To continue using this model now, enable usage from your available balance - https://opencode.ai/workspace/wrk_fixture/go" } },
  });
  const error = codec.classifyFailure?.({ stdout, stderr: "", exitCode: 1, latencyMs: 1 }, plain);
  assert.deepEqual([error?.code, error?.message, error?.retryable],
    ["RATE_LIMITED", "OpenCode rate limited: usage limit reached; resets in 2 days 3 hours", false]);
  assert.throws(() => codec.parse({ stdout, stderr: "", exitCode: 0, latencyMs: 1 }, plain), (thrown: unknown) =>
    thrown instanceof ModelInvocationError && thrown.code === "RATE_LIMITED" && !thrown.retryable);
  const stderrOnly = codec.classifyFailure?.({ stdout: "", stderr: "Error: Too Many Requests", exitCode: 1, latencyMs: 1 }, plain);
  assert.deepEqual([stderrOnly?.code, stderrOnly?.message, stderrOnly?.retryable], ["RATE_LIMITED", "OpenCode rate limited: rate limit reached", false]);
  const text = codec.classifyFailure?.({
    stdout: JSON.stringify({ type: "text", part: { type: "text", text: "usage limit reached" } }), stderr: "", exitCode: 1, latencyMs: 1,
  }, plain);
  assert.deepEqual([text?.code, text?.message], ["RUNTIME_FAILURE", "OpenCode failed with exit code 1"]);
});
