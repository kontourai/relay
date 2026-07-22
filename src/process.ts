import { spawn } from "node:child_process";
import { ModelInvocationError, type ModelInvocationOptions, type ModelInvocationRequest, type ModelInvocationResult, type ModelRuntime, type ModelRuntimeCapabilities } from "./types.js";

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
  parse(output: ProcessInvocationOutput, request: ModelInvocationRequest): ModelInvocationResult;
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
  maxOutputBytes?: number;
  now?: () => number;
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
      const started = now();
      const output = await executeProcess({
        executable: options.executable,
        invocation,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.environment ? { environment: options.environment } : {}),
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
      try {
        return options.codec.parse(normalized, request);
      } catch (error) {
        if (error instanceof ModelInvocationError) throw error;
        throw new ModelInvocationError("RUNTIME_FAILURE", "Harness returned an invalid response", false, { cause: error });
      }
    },
  };
}

async function executeProcess(input: {
  executable: string;
  invocation: ProcessInvocation;
  cwd?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  maxOutputBytes: number;
  signal?: AbortSignal;
}): Promise<CapturedProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, [...input.invocation.args], {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      env: input.environment ? { ...process.env, ...input.environment } : process.env,
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
