import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPhysicalBatchConformance, checkRuntimeConformance, FakeModelRuntime, invocationDigest, ModelInvocationError, RecordingModelRuntime, ReplayModelRuntime } from "../src/index.js";

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

  it("does not leak a delegate's physical-batch claim through a single-call recording wrapper", async () => {
    const report = await checkRuntimeConformance(
      new RecordingModelRuntime(new FakeModelRuntime([result])),
    );
    assert.equal(report.passed, true);
    assert.equal(report.checks.find(({ name }) => name === "physical-batch-declaration")?.detail, "physical batch unavailable");
  });

  it("performs one physical batch with positional successes and failures", async () => {
    const second = { ...result, model: "fixture-2", outputText: "second" };
    const runtime = new FakeModelRuntime([
      result,
      { code: "RATE_LIMITED", message: "limited", retryable: true },
      second,
    ]);
    const outcomes = await runtime.invokeBatch!([
      { messages: [{ role: "user", content: "first" }] },
      { messages: [{ role: "user", content: "fails" }] },
      { messages: [{ role: "user", content: "third" }] },
    ]);
    assert.equal(runtime.physicalInvocationCount, 1);
    assert.equal(runtime.batchRequests.length, 1);
    assert.deepEqual(outcomes.map((outcome) =>
      outcome.status === "fulfilled" ? outcome.value.outputText : outcome.reason.code),
    ["ok", "RATE_LIMITED", "second"]);
  });

  it("reports content-free physical-batch conformance with a partial item failure", async () => {
    const runtime = new FakeModelRuntime([
      result,
      { code: "RATE_LIMITED", message: "fixture-sensitive-detail", retryable: true },
    ]);
    const report = await checkPhysicalBatchConformance(runtime, [
      { messages: [{ role: "user", content: "private first probe" }] },
      { messages: [{ role: "user", content: "private second probe" }] },
    ], { requireMixedOutcomes: true });
    assert.equal(report.passed, true);
    assert.equal(runtime.physicalInvocationCount, 1);
    assert.doesNotMatch(JSON.stringify(report), /private|fixture-sensitive-detail/);
  });

  it("cancels a physical batch before launch without consuming capacity", async () => {
    const runtime = new FakeModelRuntime([result]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => runtime.invokeBatch!([request], { signal: controller.signal }),
      (error: unknown) => error instanceof ModelInvocationError && error.code === "ABORTED",
    );
    assert.equal(runtime.physicalInvocationCount, 0);
    assert.equal(runtime.requests.length, 0);
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

  it("rejects an uncallable or unbounded physical-batch declaration", async () => {
    const runtime = new FakeModelRuntime([result]);
    const { maxBatchSize: _maxBatchSize, ...capabilities } = runtime.capabilities();
    const contradictory = {
      id: runtime.id,
      capabilities: () => ({
        ...capabilities,
        physicalBatch: true as const,
      }),
      invoke: runtime.invoke.bind(runtime),
    };
    const report = await checkRuntimeConformance(contradictory);
    assert.equal(report.passed, false);
    assert.equal(report.checks.find(({ name }) => name === "physical-batch-declaration")?.passed, false);
  });
});
