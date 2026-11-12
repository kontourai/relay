import type { ModelRuntime } from "./types.js";
import { createAnthropicRuntime } from "./anthropic.js";
import { createClaudeCodeRuntime, type ClaudeCodeIsolation } from "./claude-code.js";
import { createCodexRuntime } from "./codex.js";
import { createOpenCodeRuntime } from "./opencode.js";
import type { ProcessEnvironmentInheritance, ProcessGroupMode } from "./process.js";

export const MODEL_RUNTIME_PROFILES = ["claude-code", "codex", "opencode", "anthropic"] as const;
export type ModelRuntimeProfile = (typeof MODEL_RUNTIME_PROFILES)[number];

/** Portable declarative runtime identity. Routing order and fallback remain host policy. */
export interface ModelRuntimeProfileSpec {
  profile: ModelRuntimeProfile;
  model: string;
}

export interface CreateModelRuntimeProfileOptions extends ModelRuntimeProfileSpec {
  executable?: string;
  cwd?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  /** Claude Code profile only, for now; other profiles reject it. */
  environmentInheritance?: ProcessEnvironmentInheritance;
  /** Claude Code profile only; other profiles reject it. */
  isolation?: ClaudeCodeIsolation;
  /** Claude Code profile only, for now; other profiles reject it. */
  processGroup?: ProcessGroupMode;
  maxOutputBytes?: number;
  allowPromptedStructuredOutput?: boolean;
  apiKey?: string;
  baseUrl?: string;
  /** Anthropic profile only: SDK retries per invocation (default 0). */
  maxRetries?: number;
  /** Anthropic profile only: per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export function parseModelRuntimeProfile(value: string): ModelRuntimeProfileSpec {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) throw new Error("runtime profile must use PROFILE:MODEL");
  const profile = value.slice(0, separator);
  const model = value.slice(separator + 1);
  if (!MODEL_RUNTIME_PROFILES.includes(profile as ModelRuntimeProfile)) throw new Error(`unknown runtime profile: ${profile}`);
  return Object.freeze({ profile: profile as ModelRuntimeProfile, model });
}

/** Construct one runtime. This function does not choose, rank, or fall back between profiles. */
export function createModelRuntimeProfile(options: CreateModelRuntimeProfileOptions): ModelRuntime {
  const processOptions = {
    model: options.model,
    ...(options.executable ? { executable: options.executable } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
  };
  if (options.profile !== "claude-code") {
    // Silently ignoring these would let a host believe a run was isolated when it was not.
    if (options.environmentInheritance !== undefined) throw new Error(`${options.profile} profile does not support environmentInheritance`);
    if (options.isolation !== undefined) throw new Error(`${options.profile} profile does not support isolation`);
    if (options.processGroup !== undefined) throw new Error(`${options.profile} profile does not support processGroup`);
  }
  switch (options.profile) {
    case "claude-code": return createClaudeCodeRuntime({
      ...processOptions,
      ...(options.environmentInheritance ? { environmentInheritance: options.environmentInheritance } : {}),
      ...(options.isolation ? { isolation: options.isolation } : {}),
      ...(options.processGroup ? { processGroup: options.processGroup } : {}),
    });
    case "codex": return createCodexRuntime(processOptions);
    case "opencode":
      if (!options.allowPromptedStructuredOutput) throw new Error("opencode structured tools require explicit prompted-output opt-in");
      return createOpenCodeRuntime({ ...processOptions, structuredOutput: "prompted" });
    case "anthropic":
      if (!options.apiKey) throw new Error("anthropic runtime requires an API key");
      return createAnthropicRuntime({
        model: options.model,
        apiKey: options.apiKey,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
  }
}
