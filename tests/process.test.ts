import assert from "node:assert/strict";
import test from "node:test";
import { createProcessRuntime, type ProcessRuntimeCodec } from "../src/process.js";
import { ModelInvocationError, type ModelInvocationRequest } from "../src/types.js";

const request: ModelInvocationRequest = { messages: [{ role: "user", content: "portable request" }] };
const capabilities = { structuredTools: false, streaming: false, abort: true, usage: false };

function jsonCodec(script: string): ProcessRuntimeCodec {
  return {
    prepare: () => ({ args: ["-e", script], stdin: JSON.stringify(request) }),
    parse(output) {
      const value = JSON.parse(output.stdout) as { text: string };
      return {
        provider: "fixture-harness",
        model: "fixture-model",
        outputText: value.text,
        toolCalls: [],
        usage: {},
        latencyMs: output.latencyMs,
      };
    },
  };
}

test("process runtime delegates request encoding and normalized response parsing", async () => {
  const runtime = createProcessRuntime({
    id: "fixture",
    executable: process.execPath,
    capabilities,
    codec: jsonCodec("process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({text:'ok'})))"),
  });
  assert.deepEqual(runtime.capabilities(), capabilities);
  const result = await runtime.invoke(request);
  assert.equal(result.outputText, "ok");
  assert.equal(result.provider, "fixture-harness");
});

test("process runtime aborts a live child", async () => {
  const controller = new AbortController();
  const runtime = createProcessRuntime({
    id: "slow-fixture",
    executable: process.execPath,
    capabilities,
    codec: jsonCodec("setInterval(() => undefined, 1000)"),
  });
  const pending = runtime.invoke(request, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (error: unknown) => error instanceof ModelInvocationError && error.code === "ABORTED");
});

test("process runtime classifies a missing executable without exposing its environment", async () => {
  const marker = "private-fixture-value";
  const runtime = createProcessRuntime({
    id: "missing-fixture",
    executable: `relay-missing-${Date.now()}`,
    capabilities,
    environment: { RELAY_PRIVATE_FIXTURE: marker },
    codec: jsonCodec(""),
  });
  await assert.rejects(runtime.invoke(request), (error: unknown) => {
    assert.ok(error instanceof ModelInvocationError);
    assert.equal(error.code, "PROVIDER_UNAVAILABLE");
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, new RegExp(marker));
    return true;
  });
});

test("process runtime bounds combined stdout and stderr", async () => {
  const runtime = createProcessRuntime({
    id: "noisy-fixture",
    executable: process.execPath,
    capabilities,
    maxOutputBytes: 8,
    codec: jsonCodec("process.stdout.write('0123456789')"),
  });
  await assert.rejects(runtime.invoke(request), (error: unknown) =>
    error instanceof ModelInvocationError && error.code === "RUNTIME_FAILURE" && /output exceeded/.test(error.message));
});

test("process profile classifies a nonzero harness exit without leaking stderr", async () => {
  const marker = "private-stderr-marker";
  const codec = jsonCodec(`process.stderr.write('${marker}'); process.exit(17)`);
  codec.classifyFailure = (output) => {
    assert.match(output.stderr, new RegExp(marker));
    return new ModelInvocationError("AUTHENTICATION_FAILED", "Harness authentication failed", false);
  };
  const runtime = createProcessRuntime({
    id: "auth-fixture",
    executable: process.execPath,
    capabilities,
    codec,
  });
  await assert.rejects(runtime.invoke(request), (error: unknown) => {
    assert.ok(error instanceof ModelInvocationError);
    assert.equal(error.code, "AUTHENTICATION_FAILED");
    assert.doesNotMatch(error.message, new RegExp(marker));
    return true;
  });
});
