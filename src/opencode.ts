import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProcessRuntime, type ProcessInvocation, type ProcessInvocationOutput, type ProcessRuntimeCodec } from "./process.js";
import { ModelInvocationError, type ModelInvocationOptions, type ModelInvocationRequest, type ModelInvocationResult, type ModelRuntime } from "./types.js";

export interface OpenCodeRuntimeOptions {
  /** OpenCode provider/model identifier, for example `zai/glm-5`. */
  model: string;
  executable?: string;
  cwd?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  maxOutputBytes?: number;
  /** Prompt-enforced JSON is opt-in because OpenCode run has no output-schema flag. */
  structuredOutput?: "reject" | "prompted";
}

interface OpenCodeEvent {
  type?: unknown;
  part?: {
    type?: unknown;
    text?: unknown;
    reason?: unknown;
    tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } };
  };
}

export function createOpenCodeRuntime(options: OpenCodeRuntimeOptions): ModelRuntime {
  const structuredOutput = options.structuredOutput ?? "reject";
  const supportsPromptedTools = structuredOutput === "prompted";
  return {
    id: `opencode:${options.model}`,
    capabilities: () => ({
      structuredTools: supportsPromptedTools,
      structuredToolsFidelity: supportsPromptedTools ? "prompted" : "unavailable",
      streaming: false,
      abort: true,
      usage: true,
    }),
    async invoke(request: ModelInvocationRequest, invocationOptions?: ModelInvocationOptions): Promise<ModelInvocationResult> {
      if (invocationOptions?.signal?.aborted) throw new ModelInvocationError("ABORTED", "Invocation aborted", false);
      validateTools(request, structuredOutput);
      const temporaryRoot = options.cwd ? undefined : await mkdtemp(path.join(os.tmpdir(), "relay-opencode-"));
      try {
        const processRuntime = createProcessRuntime({
          id: `opencode-process:${options.model}`,
          executable: options.executable ?? "opencode",
          capabilities: {
            structuredTools: supportsPromptedTools,
            structuredToolsFidelity: supportsPromptedTools ? "prompted" : "unavailable",
            streaming: false,
            abort: true,
            usage: true,
          },
          codec: createOpenCodeCodec(options.model, structuredOutput),
          cwd: options.cwd ?? temporaryRoot!,
          ...(options.environment ? { environment: options.environment } : {}),
          ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
        });
        return await processRuntime.invoke(request, invocationOptions);
      } finally {
        if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  };
}

/** Public for profile conformance fixtures; applications should construct the runtime. */
export function createOpenCodeCodec(model: string, structuredOutput: "reject" | "prompted" = "reject"): ProcessRuntimeCodec {
  return {
    prepare(request): ProcessInvocation {
      validateTools(request, structuredOutput);
      return {
        args: ["--pure", "run", "--format", "json", "--model", model],
        stdin: serializeMessages(request, structuredOutput),
      };
    },
    parse(output, request): ModelInvocationResult {
      validateTools(request, structuredOutput);
      const events = parseEvents(output.stdout);
      const text = events
        .filter((event) => event.type === "text" && typeof event.part?.text === "string")
        .map((event) => event.part!.text as string)
        .join("");
      if (!text) throw new ModelInvocationError("RUNTIME_FAILURE", "OpenCode omitted response text", false);
      const forcedTool = forcedToolFor(request);
      let structured: unknown;
      if (forcedTool) {
        try {
          structured = JSON.parse(stripCodeFence(text));
        } catch (error) {
          throw new ModelInvocationError("RUNTIME_FAILURE", "OpenCode returned invalid prompted structured output", true, { cause: error });
        }
      }
      const finish = [...events].reverse().find((event) => event.type === "step_finish" || event.part?.type === "step-finish")?.part;
      const inputTokens = finiteNumber(finish?.tokens?.input);
      const outputTokens = finiteNumber(finish?.tokens?.output);
      return Object.freeze({
        provider: "opencode",
        model,
        outputText: forcedTool ? "" : text,
        toolCalls: Object.freeze(forcedTool
          ? [{ id: "opencode-prompted-output", name: forcedTool.name, input: structured }]
          : []),
        usage: Object.freeze({
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(inputTokens === undefined || outputTokens === undefined ? {} : { totalTokens: inputTokens + outputTokens }),
        }),
        latencyMs: output.latencyMs,
        ...(typeof finish?.reason === "string" ? { stopReason: finish.reason } : {}),
        ...(forcedTool ? { warnings: Object.freeze(["Structured output was prompt-enforced, not schema-enforced by OpenCode."]) } : {}),
      });
    },
    classifyFailure(output) {
      return classifyOpenCodeFailure(output);
    },
  };
}

function validateTools(request: ModelInvocationRequest, mode: "reject" | "prompted"): void {
  if (!request.tools?.length) return;
  if (mode !== "prompted") {
    throw new ModelInvocationError("INVALID_REQUEST", "OpenCode structured output requires explicit prompted opt-in", false);
  }
  forcedToolFor(request);
}

function forcedToolFor(request: ModelInvocationRequest) {
  if (!request.tools?.length) return undefined;
  if (!request.toolChoice || request.toolChoice.type === "auto") {
    throw new ModelInvocationError("INVALID_REQUEST", "OpenCode profile requires an explicit tool choice", false);
  }
  if (request.toolChoice.type === "required") {
    if (request.tools.length !== 1) {
      throw new ModelInvocationError("INVALID_REQUEST", "Required tool choice needs exactly one declared tool", false);
    }
    return request.tools[0];
  }
  const selectedName = request.toolChoice.name;
  const named = request.tools.find((tool) => tool.name === selectedName);
  if (!named) throw new ModelInvocationError("INVALID_REQUEST", "Selected tool is not declared", false);
  return named;
}

function serializeMessages(request: ModelInvocationRequest, mode: "reject" | "prompted"): string {
  const forcedTool = request.tools?.length && mode === "prompted" ? forcedToolFor(request) : undefined;
  return [
    "Process the following provider-neutral conversation. Preserve the roles and return only the requested response.",
    ...(forcedTool ? [
      `Return only JSON matching this schema for the ${forcedTool.name} result. Do not use a Markdown fence.`,
      JSON.stringify(forcedTool.inputSchema),
    ] : []),
    JSON.stringify({ messages: request.messages }),
  ].join("\n\n");
}

function parseEvents(stdout: string): OpenCodeEvent[] {
  try {
    return stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as OpenCodeEvent);
  } catch (error) {
    throw new ModelInvocationError("RUNTIME_FAILURE", "OpenCode returned invalid JSON events", false, { cause: error });
  }
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function classifyOpenCodeFailure(output: ProcessInvocationOutput): ModelInvocationError {
  const stderr = output.stderr.toLowerCase();
  if (/auth|login|credential|api key/.test(stderr)) return new ModelInvocationError("AUTHENTICATION_FAILED", "OpenCode authentication failed", false);
  if (/rate.?limit|too many requests/.test(stderr)) return new ModelInvocationError("RATE_LIMITED", "OpenCode rate limit reached", true);
  if (/overloaded|unavailable|temporarily/.test(stderr)) return new ModelInvocationError("PROVIDER_UNAVAILABLE", "OpenCode runtime is unavailable", true);
  return new ModelInvocationError("RUNTIME_FAILURE", `OpenCode failed with exit code ${output.exitCode}`, false);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
