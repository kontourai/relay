import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkRuntimeConformance, FakeModelRuntime, invocationDigest, ModelInvocationError, RecordingModelRuntime, ReplayModelRuntime } from "../src/index.js";

const request = { messages: [{ role: "user" as const, content: "hello" }], metadata: { traceId: "trace:1" } };
const result = { provider: "fixture", model: "fixture-1", outputText: "ok", toolCalls: [], usage: { totalTokens: 2 }, latencyMs: 0 };

describe("Relay core", () => {
  it("produces order-independent request digests", () => {
    assert.equal(invocationDigest({ b: 2, a: 1 }), invocationDigest({ a: 1, b: 2 }));
  });

  it("records and deterministically replays secret-free invocations", async () => {
    const recording = new RecordingModelRuntime(new FakeModelRuntime([result]));
    assert.deepEqual(await recording.invoke(request), result);
    assert.equal(recording.records.length, 1);
    const serialized = JSON.stringify(recording.records);
    assert.doesNotMatch(serialized, /apiKey|authorization/i);
    assert.deepEqual(await new ReplayModelRuntime(recording.records).invoke(request), result);
    await assert.rejects(() => new ReplayModelRuntime(recording.records).invoke({ messages: [{ role: "user", content: "different" }] }),
      (error: unknown) => error instanceof ModelInvocationError && error.code === "INVALID_REQUEST");
  });

  it("provides a runtime conformance probe", async () => {
    const report = await checkRuntimeConformance(new FakeModelRuntime([result]));
    assert.equal(report.passed, true);
  });

  it("rejects contradictory structured-tool fidelity declarations", async () => {
    const runtime = new FakeModelRuntime([result]);
    const contradictory = {
      id: runtime.id,
      capabilities: () => ({
        structuredTools: false,
        structuredToolsFidelity: "native" as const,
        streaming: false,
        abort: true,
        usage: true,
      }),
      invoke: runtime.invoke.bind(runtime),
    };
    const report = await checkRuntimeConformance(contradictory);
    assert.equal(report.passed, false);
    assert.equal(report.checks.find(({ name }) => name === "structured-tools-fidelity")?.passed, false);
  });
});
