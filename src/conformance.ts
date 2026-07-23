import type { ModelInvocationRequest, ModelRuntime } from "./types.js";

export interface RuntimeConformanceReport {
  runtimeId: string;
  passed: boolean;
  checks: readonly { name: string; passed: boolean; detail: string }[];
}

export async function checkRuntimeConformance(runtime: ModelRuntime): Promise<RuntimeConformanceReport> {
  const request: ModelInvocationRequest = { messages: [{ role: "user", content: "relay-conformance" }], maxOutputTokens: 1 };
  const checks: { name: string; passed: boolean; detail: string }[] = [];
  const capabilities = runtime.capabilities();
  checks.push({ name: "capabilities", passed: typeof capabilities.abort === "boolean", detail: JSON.stringify(capabilities) });
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
