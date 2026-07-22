import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProcessRuntime, type ProcessInvocation, type ProcessInvocationOutput, type ProcessRuntimeCodec } from "./process.js";
import { ModelInvocationError, type ModelInvocationOptions, type ModelInvocationRequest, type ModelInvocationResult, type ModelRuntime } from "./types.js";

export interface CodexRuntimeOptions {
  model: string;
  executable?: string;
  cwd?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  maxOutputBytes?: number;
}

interface CodexEvent {
  type?: unknown;
  item?: { type?: unknown; text?: unknown };
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

export function createCodexRuntime(options: CodexRuntimeOptions): ModelRuntime {
  return {
    id: `codex:${options.model}`,
    capabilities: () => ({ structuredTools: true, structuredToolsFidelity: "native", streaming: false, abort: true, usage: true }),
    async invoke(request: ModelInvocationRequest, invocationOptions?: ModelInvocationOptions): Promise<ModelInvocationResult> {
      if (invocationOptions?.signal?.aborted) {
        throw new ModelInvocationError("ABORTED", "Invocation aborted", false);
      }
      const forcedTool = resolveForcedTool(request);
      if (forcedTool) validateCodexOutputSchema(forcedTool.inputSchema);
      const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "relay-codex-"));
      try {
        const schemaPath = forcedTool ? path.join(temporaryRoot, "output.schema.json") : undefined;
        if (schemaPath && forcedTool) await writeFile(schemaPath, JSON.stringify(forcedTool.inputSchema), { encoding: "utf8", mode: 0o600 });
        const processRuntime = createProcessRuntime({
          id: `codex-process:${options.model}`,
          executable: options.executable ?? "codex",
          capabilities: { structuredTools: true, structuredToolsFidelity: "native", streaming: false, abort: true, usage: true },
          codec: createCodexCodec(options.model, schemaPath),
          cwd: options.cwd ?? temporaryRoot,
          ...(options.environment ? { environment: options.environment } : {}),
          ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
        });
        return await processRuntime.invoke(request, invocationOptions);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  };
}

function validateCodexOutputSchema(schema: Readonly<Record<string, unknown>>): void {
  const visit = (value: unknown, schemaPath: string): void => {
    if (!isRecord(value)) {
      incompatibleSchema(schemaPath, "schema must be an object");
    }
    if (Object.keys(value).length === 0) {
      incompatibleSchema(schemaPath, "unconstrained schemas are not supported");
    }

    const declaresObject = value.type === "object" || "properties" in value;
    if (declaresObject) {
      if (value.additionalProperties !== false) {
        incompatibleSchema(schemaPath, "object schemas require additionalProperties: false");
      }
      if (!isRecord(value.properties)) {
        incompatibleSchema(schemaPath, "object schemas require a properties object");
      }
      const required = Array.isArray(value.required) ? value.required : [];
      for (const [propertyName, propertySchema] of Object.entries(value.properties)) {
        if (!required.includes(propertyName)) {
          incompatibleSchema(`${schemaPath}/properties/${escapePointer(propertyName)}`, "properties must be required; express optional values with a nullable schema");
        }
        visit(propertySchema, `${schemaPath}/properties/${escapePointer(propertyName)}`);
      }
    }

    const declaresArray = value.type === "array" || "items" in value;
    if (declaresArray) {
      if (!("items" in value)) incompatibleSchema(schemaPath, "array schemas require items");
      visit(value.items, `${schemaPath}/items`);
    }

    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      const branches = value[keyword];
      if (branches === undefined) continue;
      if (!Array.isArray(branches) || branches.length === 0) incompatibleSchema(`${schemaPath}/${keyword}`, `${keyword} requires at least one schema`);
      branches.forEach((branch, index) => visit(branch, `${schemaPath}/${keyword}/${index}`));
    }
    for (const keyword of ["$defs", "definitions"] as const) {
      const definitions = value[keyword];
      if (definitions === undefined) continue;
      if (!isRecord(definitions)) incompatibleSchema(`${schemaPath}/${keyword}`, `${keyword} must be an object`);
      for (const [name, definition] of Object.entries(definitions)) {
        visit(definition, `${schemaPath}/${keyword}/${escapePointer(name)}`);
      }
    }
  };

  visit(schema, "#");
}

function incompatibleSchema(schemaPath: string, reason: string): never {
  throw new ModelInvocationError("INVALID_REQUEST", `Codex structured-output schema is incompatible at ${schemaPath}: ${reason}`, false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Public for profile conformance fixtures; applications should construct the runtime. */
export function createCodexCodec(model: string, schemaPath?: string): ProcessRuntimeCodec {
  return {
    prepare(request): ProcessInvocation {
      const forcedTool = resolveForcedTool(request);
      if (forcedTool && !schemaPath) {
        throw new ModelInvocationError("INVALID_REQUEST", "Codex structured output requires a schema file", false);
      }
      const args = [
        "--ask-for-approval", "never",
        "exec",
        "--json",
        "--ephemeral",
        "--color", "never",
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "--ignore-rules",
        "--model", model,
      ];
      if (schemaPath) args.push("--output-schema", schemaPath);
      args.push("-");
      return { args, stdin: serializeMessages(request) };
    },
    parse(output, request): ModelInvocationResult {
      const events = parseEvents(output.stdout);
      const text = [...events].reverse().find((event) =>
        event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string")?.item?.text;
      if (typeof text !== "string") {
        throw new ModelInvocationError("RUNTIME_FAILURE", "Codex omitted its final agent message", false);
      }
      const forcedTool = resolveForcedTool(request);
      let structuredOutput: unknown;
      if (forcedTool) {
        try {
          structuredOutput = JSON.parse(text);
        } catch (error) {
          throw new ModelInvocationError("RUNTIME_FAILURE", "Codex returned invalid structured output", false, { cause: error });
        }
      }
      const usageEvent = [...events].reverse().find((event) => event.type === "turn.completed" && event.usage)?.usage;
      const inputTokens = finiteNumber(usageEvent?.input_tokens);
      const outputTokens = finiteNumber(usageEvent?.output_tokens);
      return Object.freeze({
        provider: "codex",
        model,
        outputText: forcedTool ? "" : text,
        toolCalls: Object.freeze(forcedTool
          ? [{ id: "codex-structured-output", name: forcedTool.name, input: structuredOutput }]
          : []),
        usage: Object.freeze({
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(inputTokens === undefined || outputTokens === undefined ? {} : { totalTokens: inputTokens + outputTokens }),
        }),
        latencyMs: output.latencyMs,
        stopReason: "completed",
      });
    },
    classifyFailure(output) {
      return classifyCodexFailure(output);
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
    throw new ModelInvocationError("INVALID_REQUEST", "Codex profile requires an explicit tool choice", false);
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
  return [
    "Process the following provider-neutral conversation. Preserve the roles and return only the requested response.",
    JSON.stringify({ messages: request.messages }),
  ].join("\n\n");
}

function parseEvents(stdout: string): CodexEvent[] {
  try {
    return stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as CodexEvent);
  } catch (error) {
    throw new ModelInvocationError("RUNTIME_FAILURE", "Codex returned invalid JSON events", false, { cause: error });
  }
}

function classifyCodexFailure(output: ProcessInvocationOutput): ModelInvocationError {
  const stderr = output.stderr.toLowerCase();
  if (/auth|login|credential|api key/.test(stderr)) {
    return new ModelInvocationError("AUTHENTICATION_FAILED", "Codex authentication failed", false);
  }
  if (/rate.?limit|too many requests/.test(stderr)) {
    return new ModelInvocationError("RATE_LIMITED", "Codex rate limit reached", true);
  }
  if (/overloaded|unavailable|temporarily/.test(stderr)) {
    return new ModelInvocationError("PROVIDER_UNAVAILABLE", "Codex runtime is unavailable", true);
  }
  return new ModelInvocationError("RUNTIME_FAILURE", `Codex failed with exit code ${output.exitCode}`, false);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
