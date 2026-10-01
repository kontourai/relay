import { ModelInvocationError, type ModelInvocationRequest, type ModelInvocationResult, type ModelRuntime, type ModelTool } from "./types.js";
import { detectUsageLimit, toolDescriptionLines } from "./harness-text.js";
import { createProcessRuntime, type ProcessInvocation, type ProcessInvocationOutput, type ProcessRuntimeCodec } from "./process.js";

export interface ClaudeCodeRuntimeOptions {
  model: string;
  executable?: string;
  cwd?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  maxOutputBytes?: number;
}

interface ClaudeCodeJsonResult {
  result?: unknown;
  structured_output?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
  total_cost_usd?: unknown;
  /** Keyed by the model id the provider served; can list several models for one run. */
  modelUsage?: unknown;
  stop_reason?: unknown;
  is_error?: unknown;
  api_error_status?: unknown;
}

export function createClaudeCodeRuntime(options: ClaudeCodeRuntimeOptions): ModelRuntime {
  return createProcessRuntime({
    id: `claude-code:${options.model}`,
    executable: options.executable ?? "claude",
    capabilities: {
      structuredTools: true,
      structuredToolsFidelity: "native",
      outputTokenLimitFidelity: "unavailable",
      streaming: false,
      abort: true,
      usage: true,
    },
    codec: createClaudeCodeCodec(options.model),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
  });
}

/** Public for profile conformance fixtures; applications should construct the runtime. */
export function createClaudeCodeCodec(model: string): ProcessRuntimeCodec {
  return {
    prepare(request): ProcessInvocation {
      const forcedTool = resolveForcedTool(request);
      const args = [
        "--print",
        "--output-format", "json",
        "--model", model,
        "--no-session-persistence",
        "--tools", "",
        "--permission-mode", "dontAsk",
      ];
      if (forcedTool) args.push("--json-schema", JSON.stringify(forcedTool.inputSchema));
      return { args, stdin: serializeMessages(request, forcedTool) };
    },
    parse(output, request): ModelInvocationResult {
      const parsed = parseJsonResult(output.stdout);
      if (parsed.is_error === true) {
        throw rateLimited(output)
          ?? new ModelInvocationError("RUNTIME_FAILURE", "Claude Code reported an invocation error", false);
      }
      const forcedTool = resolveForcedTool(request);
      if (forcedTool && parsed.structured_output === undefined) {
        throw new ModelInvocationError("RUNTIME_FAILURE", "Claude Code omitted required structured output", false);
      }
      const inputTokens = finiteNumber(parsed.usage?.input_tokens);
      const outputTokens = finiteNumber(parsed.usage?.output_tokens);
      const cacheReadTokens = finiteNumber(parsed.usage?.cache_read_input_tokens);
      const cacheWriteTokens = finiteNumber(parsed.usage?.cache_creation_input_tokens);
      const costUsd = finiteNumber(parsed.total_cost_usd);
      const outputText = typeof parsed.result === "string" ? parsed.result : "";
      const warnings = request.maxOutputTokens !== undefined
        && outputTokens !== undefined
        && outputTokens > request.maxOutputTokens
        ? [`OUTPUT_TOKEN_LIMIT_NOT_ENFORCED: requested ${request.maxOutputTokens}, observed ${outputTokens}`]
        : [];
      return Object.freeze({
        provider: "claude-code",
        ...servedModel(parsed.modelUsage, model),
        outputText,
        toolCalls: Object.freeze(forcedTool
          ? [{ id: "claude-code-structured-output", name: forcedTool.name, input: parsed.structured_output }]
          : []),
        usage: Object.freeze({
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(inputTokens === undefined || outputTokens === undefined ? {} : { totalTokens: inputTokens + outputTokens }),
          ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
          ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
          ...(costUsd === undefined ? {} : { costUsd }),
        }),
        latencyMs: output.latencyMs,
        ...(typeof parsed.stop_reason === "string" ? { stopReason: parsed.stop_reason } : {}),
        ...(warnings.length ? { warnings: Object.freeze(warnings) } : {}),
      });
    },
    classifyFailure(output) {
      return classifyClaudeCodeFailure(output);
    },
  };
}

function resolveForcedTool(request: ModelInvocationRequest) {
  if (!request.tools?.length) {
    if (request.toolChoice && request.toolChoice.type !== "auto") {
      throw new ModelInvocationError("INVALID_REQUEST", "Tool choice requires a declared tool", false);
    }
    return undefined;
  }
  if (!request.toolChoice || request.toolChoice.type === "auto") {
    throw new ModelInvocationError("INVALID_REQUEST", "Claude Code profile requires an explicit tool choice", false);
  }
  if (request.toolChoice.type === "required") {
    if (request.tools.length !== 1) {
      throw new ModelInvocationError("INVALID_REQUEST", "Required tool choice needs exactly one declared tool", false);
    }
    return request.tools[0];
  }
  const selectedName = request.toolChoice.name;
  const selected = request.tools.find((tool) => tool.name === selectedName);
  if (!selected) throw new ModelInvocationError("INVALID_REQUEST", "Selected tool is not declared", false);
  return selected;
}

function serializeMessages(request: ModelInvocationRequest, forcedTool: ModelTool | undefined): string {
  const messages = request.messages.map((message) => ({
    role: message.role,
    content: typeof message.content === "string" ? message.content : message.content,
  }));
  return [
    "Process the following provider-neutral conversation. Preserve the roles and return only the requested response.",
    ...toolDescriptionLines(forcedTool),
    JSON.stringify({ messages }),
  ].join("\n\n");
}

function parseJsonResult(stdout: string): ClaudeCodeJsonResult {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as ClaudeCodeJsonResult;
  } catch (error) {
    throw new ModelInvocationError("RUNTIME_FAILURE", "Claude Code returned invalid JSON", false, { cause: error });
  }
}

/**
 * The CLI reports a usage limit as an error result on stdout (`is_error`, the
 * limit message in `result`, `api_error_status` 429), not on stderr. Only that
 * error text is inspected, never a successful model response.
 */
function rateLimited(output: ProcessInvocationOutput): ModelInvocationError | undefined {
  let result: ClaudeCodeJsonResult = {};
  try {
    const parsed = JSON.parse(output.stdout) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) result = parsed as ClaudeCodeJsonResult;
  } catch {
    // A failed run may print no JSON at all; stderr is still inspected.
  }
  const errorText = result.is_error === true && typeof result.result === "string" ? result.result : "";
  const reason = detectUsageLimit([errorText, output.stderr])
    ?? (result.is_error === true && result.api_error_status === 429 ? "rate limit reached" : undefined);
  // Not retryable on this runtime: the CLI already retried, and a usage limit
  // lasts until its reset. A router can move to its next candidate.
  return reason ? new ModelInvocationError("RATE_LIMITED", `Claude Code rate limited: ${reason}`, false) : undefined;
}

function classifyClaudeCodeFailure(output: ProcessInvocationOutput): ModelInvocationError {
  const limited = rateLimited(output);
  if (limited) return limited;
  const stderr = output.stderr.toLowerCase();
  if (/auth|login|credential|api key/.test(stderr)) {
    return new ModelInvocationError("AUTHENTICATION_FAILED", "Claude Code authentication failed", false);
  }
  if (/overloaded|unavailable|temporarily/.test(stderr)) {
    return new ModelInvocationError("PROVIDER_UNAVAILABLE", "Claude Code runtime is unavailable", true);
  }
  return new ModelInvocationError("RUNTIME_FAILURE", `Claude Code failed with exit code ${output.exitCode}`, false);
}

/**
 * Claude Code reports usage per served model id. Exactly one entry identifies
 * the model that served the run; zero or several (for example a helper model
 * used alongside the main one) would make any single choice a guess.
 */
function servedModel(modelUsage: unknown, configured: string): Pick<ModelInvocationResult, "model" | "modelSource"> {
  if (typeof modelUsage === "object" && modelUsage !== null && !Array.isArray(modelUsage)) {
    const models = Object.keys(modelUsage);
    if (models.length === 1 && models[0]) return { model: models[0], modelSource: "provider-reported" };
  }
  return { model: configured, modelSource: "configured" };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
