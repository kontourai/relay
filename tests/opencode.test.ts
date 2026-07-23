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
