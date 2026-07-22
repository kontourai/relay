import type { ModelInvocationOptions, ModelInvocationRequest, ModelInvocationResult, ModelRuntime, ModelRuntimeCapabilities } from "./types.js";
import { ModelInvocationError } from "./types.js";

const capabilities: ModelRuntimeCapabilities = Object.freeze({ structuredTools: true, structuredToolsFidelity: "native", streaming: false, abort: true, usage: true });

export class FakeModelRuntime implements ModelRuntime {
  readonly id: string;
  readonly requests: ModelInvocationRequest[] = [];
  #results: ModelInvocationResult[];

  constructor(results: readonly ModelInvocationResult[], id = "fake") {
    this.id = id;
    this.#results = structuredClone([...results]);
  }

  capabilities(): ModelRuntimeCapabilities { return capabilities; }

  async invoke(request: ModelInvocationRequest, options?: ModelInvocationOptions): Promise<ModelInvocationResult> {
    if (options?.signal?.aborted) throw new ModelInvocationError("ABORTED", "Invocation aborted", false);
    this.requests.push(structuredClone(request));
    const result = this.#results.shift();
    if (!result) throw new ModelInvocationError("RUNTIME_FAILURE", "Fake runtime has no queued result", false);
    return Object.freeze(structuredClone(result));
  }
}
