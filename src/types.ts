export type JsonSchema = Readonly<Record<string, unknown>>;

export type ModelMessageContentPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; name: string; output: unknown; isError?: boolean };

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** A string retains the v0.1 text-only contract byte-for-byte. */
  content: string | readonly ModelMessageContentPart[];
}

export interface ModelTool {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}

export type ModelToolChoice =
  | { type: "auto" }
  | { type: "required" }
  | { type: "tool"; name: string };

export interface ModelInvocationRequest {
  messages: readonly ModelMessage[];
  tools?: readonly ModelTool[];
  toolChoice?: ModelToolChoice;
  maxOutputTokens?: number;
  /** Secret-free caller correlation only. Adapters must not interpret it. */
  metadata?: Readonly<Record<string, string>>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Input tokens served from a provider cache, when separately reported. */
  cacheReadTokens?: number;
  /** Input tokens written to a provider cache, when separately reported. */
  cacheWriteTokens?: number;
  /** Provider-reported invocation cost in US dollars; Relay never estimates it. */
  costUsd?: number;
}

export interface ModelInvocationResult {
  provider: string;
  model: string;
  outputText: string;
  toolCalls: readonly ModelToolCall[];
  usage: ModelUsage;
  latencyMs: number;
  stopReason?: string;
  warnings?: readonly string[];
}

export interface ModelRuntimeCapabilities {
  structuredTools: boolean;
  /** Optional evidence about how structured tool output is produced. */
  structuredToolsFidelity?: "native" | "prompted" | "unavailable";
  /**
   * Whether maxOutputTokens is enforced by the runtime, only approximated, or
   * unavailable. Optional for compatibility with pre-0.5 custom runtimes.
   */
  outputTokenLimitFidelity?: "native" | "approximated" | "unavailable";
  streaming: boolean;
  abort: boolean;
  usage: boolean;
}

export interface ModelInvocationOptions {
  signal?: AbortSignal;
}

export interface ModelRuntime {
  readonly id: string;
  capabilities(): ModelRuntimeCapabilities;
  invoke(request: ModelInvocationRequest, options?: ModelInvocationOptions): Promise<ModelInvocationResult>;
}

export type ModelInvocationErrorCode =
  | "ABORTED"
  | "AUTHENTICATION_FAILED"
  | "INVALID_REQUEST"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "RUNTIME_FAILURE";

export class ModelInvocationError extends Error {
  constructor(
    readonly code: ModelInvocationErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelInvocationError";
  }
}
