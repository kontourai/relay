import { ModelInvocationError, type ModelInvocationRequest, type ModelInvocationResult, type ModelRuntime } from "./types.js";
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
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
  stop_reason?: unknown;
  is_error?: unknown;
}

export function createClaudeCodeRuntime(options: ClaudeCodeRuntimeOptions): ModelRuntime {
  return createProcessRuntime({
    id: `claude-code:${options.model}`,
    executable: options.executable ?? "claude",
    capabilities: { structuredTools: true, structuredToolsFidelity: "native", streaming: false, abort: true, usage: true },
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
      return { args, stdin: serializeMessages(request) };
    },
    parse(output, request): ModelInvocationResult {
      const parsed = parseJsonResult(output.stdout);
      if (parsed.is_error === true) {
        throw new ModelInvocationError("RUNTIME_FAILURE", "Claude Code reported an invocation error", false);
      }
      const forcedTool = resolveForcedTool(request);
      if (forcedTool && parsed.structured_output === undefined) {
        throw new ModelInvocationError("RUNTIME_FAILURE", "Claude Code omitted required structured output", false);
      }
      const inputTokens = finiteNumber(parsed.usage?.input_tokens);
      const outputTokens = finiteNumber(parsed.usage?.output_tokens);
      const outputText = typeof parsed.result === "string" ? parsed.result : "";
      return Object.freeze({
        provider: "claude-code",
        model,
        outputText,
        toolCalls: Object.freeze(forcedTool
          ? [{ id: "claude-code-structured-output", name: forcedTool.name, input: parsed.structured_output }]
          : []),
        usage: Object.freeze({
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(inputTokens === undefined || outputTokens === undefined ? {} : { totalTokens: inputTokens + outputTokens }),
        }),
        latencyMs: output.latencyMs,
        ...(typeof parsed.stop_reason === "string" ? { stopReason: parsed.stop_reason } : {}),
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

function serializeMessages(request: ModelInvocationRequest): string {
  const messages = request.messages.map((message) => ({
    role: message.role,
    content: typeof message.content === "string" ? message.content : message.content,
  }));
  return [
    "Process the following provider-neutral conversation. Preserve the roles and return only the requested response.",
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

function classifyClaudeCodeFailure(output: ProcessInvocationOutput): ModelInvocationError {
  const stderr = output.stderr.toLowerCase();
  if (/auth|login|credential|api key/.test(stderr)) {
    return new ModelInvocationError("AUTHENTICATION_FAILED", "Claude Code authentication failed", false);
  }
  if (/rate.?limit|too many requests/.test(stderr)) {
    return new ModelInvocationError("RATE_LIMITED", "Claude Code rate limit reached", true);
  }
  if (/overloaded|unavailable|temporarily/.test(stderr)) {
    return new ModelInvocationError("PROVIDER_UNAVAILABLE", "Claude Code runtime is unavailable", true);
  }
  return new ModelInvocationError("RUNTIME_FAILURE", `Claude Code failed with exit code ${output.exitCode}`, false);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
