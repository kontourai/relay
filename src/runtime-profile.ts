import type { ModelRuntime } from "./types.js";
import { createAnthropicRuntime } from "./anthropic.js";
import { createClaudeCodeRuntime } from "./claude-code.js";
import { createCodexRuntime } from "./codex.js";
import { createOpenCodeRuntime } from "./opencode.js";

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
  maxOutputBytes?: number;
  allowPromptedStructuredOutput?: boolean;
  apiKey?: string;
  baseUrl?: string;
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
  switch (options.profile) {
    case "claude-code": return createClaudeCodeRuntime(processOptions);
    case "codex": return createCodexRuntime(processOptions);
    case "opencode":
      if (!options.allowPromptedStructuredOutput) throw new Error("opencode structured tools require explicit prompted-output opt-in");
      return createOpenCodeRuntime({ ...processOptions, structuredOutput: "prompted" });
    case "anthropic":
      if (!options.apiKey) throw new Error("anthropic runtime requires an API key");
      return createAnthropicRuntime({ model: options.model, apiKey: options.apiKey, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) });
  }
}
