import type {
  ModelBatchInvocationOutcome,
  ModelInvocationFailure,
  ModelInvocationOptions,
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelRuntime,
  ModelRuntimeCapabilities,
} from "./types.js";
import { ModelInvocationError } from "./types.js";

const capabilities: ModelRuntimeCapabilities = Object.freeze({
  structuredTools: true,
  structuredToolsFidelity: "native",
  outputTokenLimitFidelity: "native",
  streaming: false,
  abort: true,
  usage: true,
  physicalBatch: true,
  maxBatchSize: 100,
});

type FakeOutcome = ModelInvocationResult | ModelInvocationFailure;

function isFailure(outcome: FakeOutcome): outcome is ModelInvocationFailure {
  return "code" in outcome && "retryable" in outcome && !("provider" in outcome);
}

export class FakeModelRuntime implements ModelRuntime {
  readonly id: string;
  readonly requests: ModelInvocationRequest[] = [];
  readonly batchRequests: ModelInvocationRequest[][] = [];
  physicalInvocationCount = 0;
  #results: FakeOutcome[];

  constructor(results: readonly FakeOutcome[], id = "fake") {
    this.id = id;
    this.#results = structuredClone([...results]);
  }

  capabilities(): ModelRuntimeCapabilities { return capabilities; }

  async invoke(request: ModelInvocationRequest, options?: ModelInvocationOptions): Promise<ModelInvocationResult> {
    if (options?.signal?.aborted) throw new ModelInvocationError("ABORTED", "Invocation aborted", false);
    this.physicalInvocationCount++;
    this.requests.push(structuredClone(request));
    const result = this.#results.shift();
    if (!result) throw new ModelInvocationError("RUNTIME_FAILURE", "Fake runtime has no queued result", false);
    if (isFailure(result)) throw new ModelInvocationError(result.code, result.message, result.retryable);
    return Object.freeze(structuredClone(result));
  }

  async invokeBatch(
    requests: readonly ModelInvocationRequest[],
    options?: ModelInvocationOptions,
  ): Promise<readonly ModelBatchInvocationOutcome[]> {
    if (options?.signal?.aborted) throw new ModelInvocationError("ABORTED", "Batch invocation aborted", false);
    if (requests.length === 0 || requests.length > capabilities.maxBatchSize!) {
      throw new ModelInvocationError("INVALID_REQUEST", `Batch size must be between 1 and ${capabilities.maxBatchSize}`, false);
    }
    this.physicalInvocationCount++;
    const copied = structuredClone([...requests]);
    this.batchRequests.push(copied);
    this.requests.push(...copied);
    return Object.freeze(requests.map((): ModelBatchInvocationOutcome => {
      const outcome = this.#results.shift();
      if (!outcome) {
        return Object.freeze({
          status: "rejected",
          reason: {
            code: "RUNTIME_FAILURE" as const,
            message: "Fake runtime has no queued result",
            retryable: false,
          },
        });
      }
      return isFailure(outcome)
        ? Object.freeze({ status: "rejected", reason: structuredClone(outcome) })
        : Object.freeze({ status: "fulfilled", value: structuredClone(outcome) });
    }));
  }
}
