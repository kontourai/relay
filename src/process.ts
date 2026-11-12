import { spawn } from "node:child_process";
import { ModelInvocationError, type ModelExecutionEnvironment, type ModelInvocationOptions, type ModelInvocationRequest, type ModelInvocationResult, type ModelRuntime, type ModelRuntimeCapabilities } from "./types.js";

export interface ProcessInvocation {
  args: readonly string[];
  stdin?: string;
}

export interface ProcessInvocationOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  latencyMs: number;
}

export interface ProcessRuntimeCodec {
  prepare(request: ModelInvocationRequest): ProcessInvocation;
  /**
   * `invocation` is the exact argv and stdin the transport spawned for this
   * request. The transport always passes it; it is optional so fixtures can
   * call `parse` directly.
   */
  parse(output: ProcessInvocationOutput, request: ModelInvocationRequest, invocation?: ProcessInvocation): ModelInvocationResult;
  /** Convert a nonzero exit to a secret-free typed failure. */
  classifyFailure?(output: ProcessInvocationOutput, request: ModelInvocationRequest): ModelInvocationError;
}

export interface ProcessRuntimeOptions {
  id: string;
  executable: string;
  capabilities: ModelRuntimeCapabilities;
  codec: ProcessRuntimeCodec;
  cwd?: string;
  /** Constructor-only process environment. Relay never copies it into results or errors. */
  environment?: Readonly<NodeJS.ProcessEnv>;
  /**
   * Which of the parent's variables the child inherits before `environment` is
   * applied. Default `{ inherit: "all" }`. See `ProcessEnvironmentInheritance`.
   */
  environmentInheritance?: ProcessEnvironmentInheritance;
  maxOutputBytes?: number;
  now?: () => number;
}

/**
 * `all` copies the parent's whole `process.env` (the historical behaviour).
 * `allowlist` copies only `PROCESS_ENVIRONMENT_BASE` for this platform plus the
 * names in `allow`, so an ambient API key, token, or base URL never reaches the
 * child unless the host names it. Names are matched exactly, except on Windows,
 * where environment names are case-insensitive.
 */
export type ProcessEnvironmentInheritance =
  | { readonly inherit: "all" }
  | { readonly inherit: "allowlist"; readonly allow: readonly string[] };

/**
 * The variables an allowlisted child inherits without being named:
 * - `PATH`: resolves the executable's own interpreter and subprocesses.
 * - `HOME`: where harnesses keep their login and configuration.
 * - `USER`: on macOS, Claude Code finds its subscription login in the keychain
 *   by user name; without it the CLI reports that it is not logged in.
 * - `TMPDIR`: keeps temporary files in the per-user directory instead of a
 *   shared `/tmp`.
 * On Windows the equivalents are `Path`/`PATHEXT` (command resolution),
 * `SystemRoot` (required by system libraries, including networking),
 * `USERPROFILE`/`USERNAME`/`APPDATA`/`LOCALAPPDATA` (home, user, and per-user
 * configuration), and `TEMP`/`TMP`.
 */
export const PROCESS_ENVIRONMENT_BASE = Object.freeze({
  posix: Object.freeze(["PATH", "HOME", "USER", "TMPDIR"] as const),
  win32: Object.freeze(["PATH", "PATHEXT", "SystemRoot", "USERPROFILE", "USERNAME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] as const),
});

/**
 * Build the exact environment a child is spawned with. Exported for hosts that
 * want to preview it; the transport uses this same function.
 */
export function buildProcessEnvironment(input: {
  parent: Readonly<NodeJS.ProcessEnv>;
  overlay?: Readonly<NodeJS.ProcessEnv>;
  inheritance?: ProcessEnvironmentInheritance;
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const inheritance = input.inheritance ?? { inherit: "all" };
  let inherited: NodeJS.ProcessEnv;
  if (inheritance.inherit === "all") {
    inherited = { ...input.parent };
  } else {
    const windows = (input.platform ?? process.platform) === "win32";
    const key = (name: string) => windows ? name.toUpperCase() : name;
    const wanted = new Set([
      ...(windows ? PROCESS_ENVIRONMENT_BASE.win32 : PROCESS_ENVIRONMENT_BASE.posix),
      ...inheritance.allow,
    ].map(key));
    inherited = {};
    for (const [name, value] of Object.entries(input.parent)) {
      if (wanted.has(key(name))) inherited[name] = value;
    }
  }
  const environment: NodeJS.ProcessEnv = { ...inherited, ...input.overlay };
  // Node drops undefined values when spawning; drop them here so the record matches.
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete environment[name];
  }
  return environment;
}

function validateInheritance(inheritance: ProcessEnvironmentInheritance | undefined): void {
  if (inheritance === undefined || inheritance.inherit === "all") return;
  if (inheritance.inherit !== "allowlist" || !Array.isArray(inheritance.allow)) {
    throw new TypeError("environmentInheritance must be { inherit: \"all\" } or { inherit: \"allowlist\", allow: string[] }");
  }
  for (const name of inheritance.allow) {
    if (typeof name !== "string" || name.length === 0 || name.includes("=") || name.includes("\0")) {
      throw new TypeError("environmentInheritance.allow entries must be non-empty variable names");
    }
  }
}

function environmentRecord(
  inheritance: ProcessEnvironmentInheritance | undefined,
  environment: NodeJS.ProcessEnv,
): ModelExecutionEnvironment {
  if (!inheritance || inheritance.inherit === "all") return Object.freeze({ inherit: "all" });
  return Object.freeze({ inherit: "allowlist", names: Object.freeze(Object.keys(environment).sort()) });
}

interface CapturedProcess {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Generic non-interactive harness transport. A profile-owned codec maps the
 * provider-neutral request to a supported CLI protocol and parses its output.
 */
export function createProcessRuntime(options: ProcessRuntimeOptions): ModelRuntime {
  validateInheritance(options.environmentInheritance);
  const inheritance = options.environmentInheritance
    ? Object.freeze(options.environmentInheritance.inherit === "all"
      ? { inherit: "all" as const }
      : { inherit: "allowlist" as const, allow: Object.freeze([...options.environmentInheritance.allow]) })
    : undefined;
  const capabilities = Object.freeze({ ...options.capabilities });
  const now = options.now ?? (() => performance.now());
  return {
    id: options.id,
    capabilities: () => capabilities,
    async invoke(request: ModelInvocationRequest, invocationOptions?: ModelInvocationOptions): Promise<ModelInvocationResult> {
      if (invocationOptions?.signal?.aborted) throw aborted();
      let invocation: ProcessInvocation;
      try {
        invocation = options.codec.prepare(request);
      } catch (error) {
        if (error instanceof ModelInvocationError) throw error;
        throw new ModelInvocationError("INVALID_REQUEST", "Harness profile rejected the invocation", false, { cause: error });
      }
      // Built per invocation so a host's later process.env changes apply, as before.
      const environment = buildProcessEnvironment({
        parent: process.env,
        ...(options.environment ? { overlay: options.environment } : {}),
        ...(inheritance ? { inheritance } : {}),
      });
      const started = now();
      const output = await executeProcess({
        executable: options.executable,
        invocation,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        environment,
        maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        ...(invocationOptions?.signal ? { signal: invocationOptions.signal } : {}),
      });
      const normalized = { ...output, latencyMs: Math.max(0, now() - started) };
      if (normalized.exitCode !== 0) {
        try {
          throw options.codec.classifyFailure?.(normalized, request) ?? classifyExit(normalized.exitCode);
        } catch (error) {
          if (error instanceof ModelInvocationError) throw error;
          throw classifyExit(normalized.exitCode);
        }
      }
      let result: ModelInvocationResult;
      try {
        result = options.codec.parse(normalized, request, invocation);
      } catch (error) {
        if (error instanceof ModelInvocationError) throw error;
        throw new ModelInvocationError("RUNTIME_FAILURE", "Harness returned an invalid response", false, { cause: error });
      }
      return Object.freeze({
        ...result,
        execution: Object.freeze({ ...result.execution, environment: environmentRecord(inheritance, environment) }),
      });
    },
  };
}

async function executeProcess(input: {
  executable: string;
  invocation: ProcessInvocation;
  cwd?: string;
  environment: NodeJS.ProcessEnv;
  maxOutputBytes: number;
  signal?: AbortSignal;
}): Promise<CapturedProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, [...input.invocation.args], {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      env: input.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const finishError = (error: ModelInvocationError) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill("SIGTERM");
      reject(error);
    };
    const onAbort = () => finishError(aborted());
    const cleanup = () => input.signal?.removeEventListener("abort", onAbort);
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > input.maxOutputBytes) {
        finishError(new ModelInvocationError("RUNTIME_FAILURE", "Harness output exceeded the configured limit", false));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finishError(new ModelInvocationError(
        code === "ENOENT" ? "PROVIDER_UNAVAILABLE" : "RUNTIME_FAILURE",
        code === "ENOENT" ? "Harness executable is unavailable" : "Harness process failed to start",
        code === "ENOENT",
        { cause: error },
      ));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input.invocation.stdin ?? "");
  });
}

function aborted(): ModelInvocationError {
  return new ModelInvocationError("ABORTED", "Invocation aborted", false);
}

function classifyExit(exitCode: number): ModelInvocationError {
  return new ModelInvocationError(
    "RUNTIME_FAILURE",
    `Harness invocation failed with exit code ${exitCode}`,
    false,
  );
}
