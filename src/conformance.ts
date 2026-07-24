import type { ModelInvocationOptions, ModelInvocationRequest, ModelRuntime } from "./types.js";

export interface RuntimeConformanceReport {
  runtimeId: string;
  passed: boolean;
  checks: readonly { name: string; passed: boolean; detail: string }[];
}

export interface PhysicalBatchConformanceReport {
  runtimeId: string;
  passed: boolean;
  /** Content-free checks; request and response bodies are never copied here. */
  checks: readonly { name: string; passed: boolean; detail: string }[];
}

/**
 * Issue exactly one physical batch and validate its portable contract.
 * Callers supply safe probe requests and may require a mixed success/failure
 * fixture when exercising a fake or injected provider client.
 */
export async function checkPhysicalBatchConformance(
  runtime: ModelRuntime,
  requests: readonly ModelInvocationRequest[],
  options: ModelInvocationOptions & { requireMixedOutcomes?: boolean } = {},
): Promise<PhysicalBatchConformanceReport> {
  const checks: { name: string; passed: boolean; detail: string }[] = [];
  const capabilities = runtime.capabilities();
  const declared = capabilities.physicalBatch === true
    && typeof runtime.invokeBatch === "function"
    && Number.isInteger(capabilities.maxBatchSize)
    && capabilities.maxBatchSize! > 0;
  checks.push({
    name: "physical-batch-declaration",
    passed: declared,
    detail: declared ? `up to ${String(capabilities.maxBatchSize)} item(s)` : "unavailable or inconsistent",
  });
  const sizeValid = requests.length > 0
    && Number.isInteger(capabilities.maxBatchSize)
    && requests.length <= capabilities.maxBatchSize!;
  checks.push({ name: "request-count", passed: sizeValid, detail: `${requests.length} item(s)` });
  if (declared && sizeValid) {
    try {
      const outcomes = await runtime.invokeBatch!(requests, options.signal ? { signal: options.signal } : undefined);
      checks.push({
        name: "positional-correspondence",
        passed: Array.isArray(outcomes) && outcomes.length === requests.length,
        detail: `${outcomes.length} outcome(s)`,
      });
      const fulfilled = outcomes.filter(({ status }) => status === "fulfilled").length;
      const rejected = outcomes.filter(({ status }) => status === "rejected").length;
      checks.push({
        name: "typed-outcomes",
        passed: fulfilled + rejected === outcomes.length,
        detail: `${fulfilled} fulfilled, ${rejected} rejected`,
      });
      if (options.requireMixedOutcomes) {
        checks.push({
          name: "partial-item-failure",
          passed: fulfilled > 0 && rejected > 0,
          detail: `${fulfilled} fulfilled, ${rejected} rejected`,
        });
      }
    } catch (error) {
      checks.push({
        name: "invoke-batch",
        passed: false,
        detail: error instanceof Error ? error.name : "non-Error rejection",
      });
    }
  }
  return Object.freeze({
    runtimeId: runtime.id,
    passed: checks.every(({ passed }) => passed),
    checks: Object.freeze(checks),
  });
}

export async function checkRuntimeConformance(runtime: ModelRuntime): Promise<RuntimeConformanceReport> {
  const request: ModelInvocationRequest = { messages: [{ role: "user", content: "relay-conformance" }], maxOutputTokens: 1 };
  const checks: { name: string; passed: boolean; detail: string }[] = [];
  const capabilities = runtime.capabilities();
  checks.push({ name: "capabilities", passed: typeof capabilities.abort === "boolean", detail: JSON.stringify(capabilities) });
  const hasBatchMethod = typeof runtime.invokeBatch === "function";
  checks.push({
    name: "physical-batch-declaration",
    passed: capabilities.physicalBatch === true
      ? hasBatchMethod && Number.isInteger(capabilities.maxBatchSize) && capabilities.maxBatchSize! > 0
      : !hasBatchMethod && capabilities.maxBatchSize === undefined,
    detail: capabilities.physicalBatch === true
      ? `physical batch up to ${String(capabilities.maxBatchSize)} item(s)`
      : "physical batch unavailable",
  });
  const fidelity = capabilities.structuredToolsFidelity;
  const fidelityConsistent = fidelity === undefined
    || (capabilities.structuredTools && (fidelity === "native" || fidelity === "prompted"))
    || (!capabilities.structuredTools && fidelity === "unavailable");
  checks.push({
    name: "structured-tools-fidelity",
    passed: fidelityConsistent,
    detail: fidelity === undefined ? "not declared" : fidelity,
  });
  const outputLimitFidelity = capabilities.outputTokenLimitFidelity;
  checks.push({
    name: "output-token-limit-fidelity",
    passed: outputLimitFidelity === undefined
      || outputLimitFidelity === "native"
      || outputLimitFidelity === "approximated"
      || outputLimitFidelity === "unavailable",
    detail: outputLimitFidelity === undefined ? "not declared" : outputLimitFidelity,
  });
  try {
    const result = await runtime.invoke(request);
    checks.push({ name: "identity", passed: Boolean(result.provider && result.model), detail: `${result.provider}/${result.model}` });
    checks.push({ name: "shape", passed: Array.isArray(result.toolCalls) && result.latencyMs >= 0, detail: "normalized result" });
  } catch (error) {
    checks.push({ name: "invoke", passed: false, detail: error instanceof Error ? error.message : String(error) });
  }
  return Object.freeze({ runtimeId: runtime.id, passed: checks.every(({ passed }) => passed), checks: Object.freeze(checks) });
}
