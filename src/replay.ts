import { invocationDigest } from "./canonical.js";
import { ModelInvocationError, type ModelInvocationOptions, type ModelInvocationRequest, type ModelInvocationResult, type ModelRuntime, type ModelRuntimeCapabilities } from "./types.js";

export interface InvocationReplayRecord {
  schemaVersion: 1;
  requestDigest: string;
  request: ModelInvocationRequest;
  result: ModelInvocationResult;
}

export class RecordingModelRuntime implements ModelRuntime {
  readonly records: InvocationReplayRecord[] = [];
  constructor(readonly runtime: ModelRuntime) {}
  get id(): string { return `recording:${this.runtime.id}`; }
  capabilities(): ModelRuntimeCapabilities {
    const { physicalBatch: _physicalBatch, maxBatchSize: _maxBatchSize, ...capabilities } = this.runtime.capabilities();
    return capabilities;
  }
  async invoke(request: ModelInvocationRequest, options?: ModelInvocationOptions): Promise<ModelInvocationResult> {
    const result = await this.runtime.invoke(request, options);
    this.records.push(Object.freeze({ schemaVersion: 1, requestDigest: invocationDigest(request), request: structuredClone(request), result: structuredClone(result) }));
    return result;
  }
}

export class ReplayModelRuntime implements ModelRuntime {
  readonly id = "replay";
  #records: Map<string, ModelInvocationResult>;
  constructor(records: readonly InvocationReplayRecord[]) {
    this.#records = new Map(records.map((record) => [record.requestDigest, structuredClone(record.result)]));
  }
  capabilities(): ModelRuntimeCapabilities { return { structuredTools: true, structuredToolsFidelity: "native", outputTokenLimitFidelity: "native", streaming: false, abort: true, usage: true }; }
  async invoke(request: ModelInvocationRequest, options?: ModelInvocationOptions): Promise<ModelInvocationResult> {
    if (options?.signal?.aborted) throw new ModelInvocationError("ABORTED", "Invocation aborted", false);
    const result = this.#records.get(invocationDigest(request));
    if (!result) throw new ModelInvocationError("INVALID_REQUEST", "No replay record matches this invocation", false);
    return Object.freeze(structuredClone(result));
  }
}
