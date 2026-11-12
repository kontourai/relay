import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createClaudeCodeCodec, createClaudeCodeRuntime, type ClaudeCodeRuntimeOptions } from "../src/claude-code.js";
import { PROCESS_ENVIRONMENT_BASE, PROCESS_TERMINATION_GRACE_MS, buildProcessEnvironment } from "../src/process.js";
import { createModelRuntimeProfile } from "../src/runtime-profile.js";
import { RecordingModelRuntime, ReplayModelRuntime } from "../src/replay.js";
import { ModelInvocationError } from "../src/types.js";

// Synthetic values only; none of these is a real credential.
const planted = {
  ANTHROPIC_BASE_URL: "http://evil.invalid",
  ANTHROPIC_API_KEY: "sk-relay-synthetic-key",
  GH_TOKEN: "gh-relay-synthetic-token",
  CLAUDE_CODE_USE_BEDROCK: "1",
  RELAY_UNRELATED_APP_SETTING: "relay-unrelated-value",
} as const;

// Stands in for `claude`: records the argv and environment it was started with,
// then prints the JSON result shape the real CLI prints.
const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.RELAY_FAKE_HANG;
let grandchildPid;
// A process the harness started; it holds no pipe to Relay.
if (mode === "grandchild") {
  grandchildPid = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" }).pid;
}
if (mode === "ignore-term") process.on("SIGTERM", () => undefined);
fs.writeFileSync(process.env.RELAY_FAKE_DUMP, JSON.stringify({ argv: process.argv.slice(2), env: process.env, pid: process.pid, grandchildPid }));
// Stands in for a run that never answers (seen with an unreachable endpoint).
if (mode) setInterval(() => undefined, 1000);
else {
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  result: "ok", is_error: false, stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { "fixture-model": {} },
})));
}
`;

interface Dump { argv: string[]; env: Record<string, string>; pid: number; grandchildPid?: number }

// Every fake process a test starts, so a failing test cannot leave one running
// (a leftover holds the test runner open until its file timeout).
const started = new Set<number>();
function killLeftovers(): void {
  for (const pid of started) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  started.clear();
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}
async function readDump(dumpPath: string): Promise<Dump | undefined> {
  try { return JSON.parse(await readFile(dumpPath, "utf8")) as Dump; } catch { return undefined; }
}

// Starts a hung fake in `mode`, aborts it once it has recorded its process ids,
// and returns those ids after the invocation settled.
// The process group a live process belongs to, as the operating system reports it.
function processGroupOf(pid: number): number {
  return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
}

async function abortHung(
  mode: string,
  processGroup?: "shared" | "isolated",
  whileRunning?: (dump: Dump) => void,
): Promise<Dump> {
  const dumpPath = path.join(directory, `dump-${mode}-${processGroup ?? "default"}-${Math.random().toString(36).slice(2)}.json`);
  const controller = new AbortController();
  const pending = createClaudeCodeRuntime({
    model: "sonnet", executable, isolation: "safe-mode",
    ...(processGroup ? { processGroup } : {}),
    environment: { RELAY_FAKE_DUMP: dumpPath, RELAY_FAKE_HANG: mode },
  }).invoke(request, { signal: controller.signal });
  let dump: Dump | undefined;
  assert.ok(await waitUntil(async () => (dump = await readDump(dumpPath)) !== undefined, 10_000), "fake never started");
  started.add(dump!.pid);
  if (dump!.grandchildPid) started.add(dump!.grandchildPid);
  let callbackError: unknown;
  try {
    whileRunning?.(dump!);
  } catch (error) {
    callbackError = error;
  }
  // Always abort and settle the invocation, so a failed check leaves nothing pending.
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof ModelInvocationError && error.code === "ABORTED");
  if (callbackError !== undefined) throw callbackError;
  return dump!;
}

const request = { messages: [{ role: "user" as const, content: "synthetic excerpt" }] };
const safeModeFlags = ["--safe-mode", "--setting-sources", ""];
const defaultArgs = ["--print", "--output-format", "json", "--model", "sonnet", "--no-session-persistence", "--tools", "", "--permission-mode", "dontAsk"];
let directory = "";
let executable = "";
const saved: Record<string, string | undefined> = {};

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "relay-fake-claude-"));
  executable = path.join(directory, "claude");
  await writeFile(executable, fakeClaude, "utf8");
  await chmod(executable, 0o755);
  for (const [name, value] of Object.entries(planted)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});

after(async () => {
  killLeftovers();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

async function run(options: Omit<ClaudeCodeRuntimeOptions, "model" | "executable"> = {}) {
  const dumpPath = path.join(directory, `dump-${Math.random().toString(36).slice(2)}.json`);
  const runtime = createClaudeCodeRuntime({
    model: "sonnet",
    executable,
    ...options,
    environment: { RELAY_FAKE_DUMP: dumpPath, ...options.environment },
  });
  const result = await runtime.invoke(request);
  const dump = JSON.parse(await readFile(dumpPath, "utf8")) as Dump;
  return { result, dump };
}

// The base names this platform inherits, among those the parent actually has.
function basePresent(): string[] {
  const base: readonly string[] = process.platform === "win32" ? PROCESS_ENVIRONMENT_BASE.win32 : PROCESS_ENVIRONMENT_BASE.posix;
  return Object.keys(process.env).filter((name) => base.includes(process.platform === "win32" ? name.toUpperCase() : name));
}

describe("Claude Code child environment and isolation", () => {
  it("keeps the default: the whole parent environment and no isolation flags", async () => {
    const { result, dump } = await run();
    for (const [name, value] of Object.entries(planted)) assert.equal(dump.env[name], value, name);
    for (const name of Object.keys(process.env)) assert.ok(name in dump.env, name);
    assert.deepEqual(dump.argv, defaultArgs);
    assert.deepEqual(result.execution, { isolationFlags: [], environment: { inherit: "all" }, processGroup: "shared" });
    // A completed child does not outlive the invocation, process group or not.
    assert.equal(alive(dump.pid), false);
  });

  it("gives an allowlisted child only the base, the allowed names, and the overlay", async () => {
    const { result, dump } = await run({
      environmentInheritance: { inherit: "allowlist", allow: [] },
      environment: { RELAY_OVERLAY: "overlay-value" },
    });
    const expected = [...basePresent(), "RELAY_FAKE_DUMP", "RELAY_OVERLAY"].sort();
    // macOS adds this one variable to every new process itself; Relay does not pass it (see the record below).
    const osAdded = process.platform === "darwin" ? new Set(["__CF_USER_TEXT_ENCODING"]) : new Set<string>();
    assert.deepEqual(Object.keys(dump.env).filter((name) => !osAdded.has(name)).sort(), expected);
    for (const name of Object.keys(planted)) assert.equal(dump.env[name], undefined, name);
    assert.equal(dump.env.RELAY_OVERLAY, "overlay-value");
    // The record lists exactly the names the child received, and no values.
    assert.deepEqual(result.execution?.environment, { inherit: "allowlist", names: expected });
    const serialized = JSON.stringify(result);
    // "1" would match token counts, so only the distinctive values are searched for.
    for (const value of Object.values(planted).filter((value) => value.length > 1)) assert.ok(!serialized.includes(value), value);
    assert.ok(!serialized.includes("overlay-value"));
  });

  it("passes a gateway URL or key only when the host names it", async () => {
    const { dump } = await run({ environmentInheritance: { inherit: "allowlist", allow: ["ANTHROPIC_BASE_URL"] } });
    assert.equal(dump.env.ANTHROPIC_BASE_URL, planted.ANTHROPIC_BASE_URL);
    assert.equal(dump.env.GH_TOKEN, undefined);
    assert.equal(dump.env.ANTHROPIC_API_KEY, undefined);
  });

  it("lets the overlay remove a base variable", async () => {
    const { result, dump } = await run({
      environmentInheritance: { inherit: "allowlist", allow: [] },
      environment: { TMPDIR: undefined },
    });
    assert.equal(dump.env.TMPDIR, undefined);
    assert.ok(result.execution?.environment?.inherit === "allowlist" && !result.execution.environment.names.includes("TMPDIR"));
  });

  it("adds --safe-mode and --setting-sources \"\" for safe-mode isolation and records both", async () => {
    const { result, dump } = await run({ isolation: "safe-mode" });
    assert.deepEqual(dump.argv, [...defaultArgs, ...safeModeFlags]);
    assert.deepEqual(result.execution?.isolationFlags, safeModeFlags);
    const none = await run({ isolation: "none" });
    assert.deepEqual(none.dump.argv, defaultArgs);
  });

  it("derives isolation evidence from the spawned argv, not the configured option", () => {
    const codec = createClaudeCodeCodec("sonnet", { isolation: "safe-mode" });
    const output = { stdout: JSON.stringify({ result: "ok", is_error: false }), stderr: "", exitCode: 0, latencyMs: 1 };
    assert.deepEqual(codec.parse(output, request, { args: defaultArgs }).execution, { isolationFlags: [] });
    assert.deepEqual(createClaudeCodeCodec("sonnet").parse(output, request, { args: [...defaultArgs, "--safe-mode"] }).execution, { isolationFlags: ["--safe-mode"] });
    // The empty value of --tools is not mistaken for an isolation flag; the --setting-sources value is kept.
    assert.deepEqual(createClaudeCodeCodec("sonnet").parse(output, request, { args: [...defaultArgs, "--setting-sources", "user"] }).execution, { isolationFlags: ["--setting-sources", "user"] });
    // Without the spawned argv there is nothing to report, so no record is made up.
    assert.equal(codec.parse(output, request).execution, undefined);
  });

  it("kills a hung child when the caller aborts", { timeout: 30_000 }, async () => {
    try {
      const { pid } = await abortHung("hang");
      assert.ok(await waitUntil(() => !alive(pid), 10_000), "hung child still running after abort");
    } finally {
      killLeftovers();
    }
  });

  it("keeps the child in the host's process group by default", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
    try {
      let childGroup = 0;
      const { pid } = await abortHung("hang", undefined, (dump) => { childGroup = processGroupOf(dump.pid); });
      // Same group as the host, so a terminal Ctrl-C reaches it.
      assert.equal(childGroup, processGroupOf(process.pid));
      assert.notEqual(childGroup, pid);
    } finally {
      killLeftovers();
    }
  });

  for (const processGroup of ["shared", "isolated"] as const) {
    it(`escalates to SIGKILL when a child ignores SIGTERM (${processGroup})`, { skip: process.platform === "win32", timeout: 30_000 }, async () => {
      try {
        const { pid } = await abortHung("ignore-term", processGroup);
        // Bounded well beyond the grace period; only SIGKILL can end this child.
        assert.ok(await waitUntil(() => !alive(pid), PROCESS_TERMINATION_GRACE_MS + 8_000), "SIGTERM-ignoring child still running after the grace period");
      } finally {
        killLeftovers();
      }
    });
  }

  it("records the process group the child was spawned with", async () => {
    const shared = await run();
    assert.equal(shared.result.execution?.processGroup, "shared");
    if (process.platform !== "win32") {
      const isolated = await run({ processGroup: "isolated" });
      assert.equal(isolated.result.execution?.processGroup, "isolated");
    }
  });

  it("isolated: the child leads its own process group", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
    try {
      let childGroup = 0;
      const { pid } = await abortHung("hang", "isolated", (dump) => { childGroup = processGroupOf(dump.pid); });
      assert.equal(childGroup, pid);
      assert.notEqual(childGroup, processGroupOf(process.pid));
    } finally {
      killLeftovers();
    }
  });

  it("isolated: kills the processes a hung child started when the caller aborts", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
    try {
      const { pid, grandchildPid } = await abortHung("grandchild", "isolated");
      assert.ok(grandchildPid, "fake did not start a grandchild");
      assert.ok(await waitUntil(() => !alive(pid) && !alive(grandchildPid), 10_000), "child or grandchild still running after abort");
    } finally {
      killLeftovers();
    }
  });

  it("isolated: kills a still-running child group when the host exits normally", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
    const dumpPath = path.join(directory, "dump-host-exit.json");
    const host = path.join(directory, "host.mjs");
    const moduleUrl = new URL("../src/claude-code.js", import.meta.url).href;
    await writeFile(host, `
import { createClaudeCodeRuntime } from ${JSON.stringify(moduleUrl)};
import { existsSync } from "node:fs";
createClaudeCodeRuntime({ model: "sonnet", executable: ${JSON.stringify(executable)}, processGroup: "isolated",
  environment: { RELAY_FAKE_DUMP: ${JSON.stringify(dumpPath)}, RELAY_FAKE_HANG: "grandchild" } })
  .invoke({ messages: [{ role: "user", content: "x" }] }).catch(() => undefined);
const timer = setInterval(() => { if (existsSync(${JSON.stringify(dumpPath)})) { clearInterval(timer); process.exit(0); } }, 25);
`, "utf8");
    try {
      const { spawnSync } = await import("node:child_process");
      const exited = spawnSync(process.execPath, [host], { stdio: "ignore", timeout: 20_000 });
      assert.equal(exited.status, 0, "host did not exit normally");
      const dump = await readDump(dumpPath);
      assert.ok(dump?.grandchildPid, "fake did not record its processes");
      started.add(dump.pid);
      started.add(dump.grandchildPid);
      assert.ok(await waitUntil(() => !alive(dump.pid) && !alive(dump.grandchildPid!), 10_000), "child group outlived the host");
    } finally {
      killLeftovers();
    }
  });

  it("rejects a model id that would be read as an option", () => {
    for (const model of ["--setting-sources", "--safe-mode", "-m", ""]) {
      assert.throws(() => createClaudeCodeRuntime({ model }), TypeError, model);
      assert.throws(() => createClaudeCodeCodec(model), TypeError, model);
    }
    assert.doesNotThrow(() => createClaudeCodeRuntime({ model: "claude-sonnet-4-5" }));
  });

  it("rejects malformed policies at construction", () => {
    const build = (options: object) => () => createClaudeCodeRuntime({ model: "sonnet", ...options } as ClaudeCodeRuntimeOptions);
    assert.throws(build({ environmentInheritance: { inherit: "allowlist", allow: [""] } }), TypeError);
    assert.throws(build({ environmentInheritance: { inherit: "allowlist", allow: ["A=B"] } }), TypeError);
    assert.throws(build({ environmentInheritance: { inherit: "allowlist" } }), TypeError);
    assert.throws(build({ environmentInheritance: { inherit: "none" } }), TypeError);
    assert.throws(build({ isolation: "bare" }), TypeError);
    assert.throws(build({ processGroup: "detached" }), TypeError);
  });

  it("forwards both options through the claude-code profile and refuses them elsewhere", async () => {
    const dumpPath = path.join(directory, "dump-profile.json");
    const result = await createModelRuntimeProfile({
      profile: "claude-code",
      model: "sonnet",
      executable,
      environment: { RELAY_FAKE_DUMP: dumpPath },
      environmentInheritance: { inherit: "allowlist", allow: [] },
      isolation: "safe-mode",
    }).invoke(request);
    const dump = JSON.parse(await readFile(dumpPath, "utf8")) as Dump;
    assert.equal(dump.env.GH_TOKEN, undefined);
    assert.deepEqual(dump.argv, [...defaultArgs, ...safeModeFlags]);
    assert.deepEqual(result.execution?.isolationFlags, safeModeFlags);
    assert.throws(() => createModelRuntimeProfile({ profile: "codex", model: "gpt-5", isolation: "safe-mode" }), /does not support isolation/);
    assert.throws(() => createModelRuntimeProfile({ profile: "codex", model: "gpt-5", processGroup: "isolated" }), /does not support processGroup/);
    assert.throws(() => createModelRuntimeProfile({
      profile: "opencode", model: "zai/glm-5", allowPromptedStructuredOutput: true,
      environmentInheritance: { inherit: "allowlist", allow: [] },
    }), /does not support environmentInheritance/);
  });
});

describe("buildProcessEnvironment", () => {
  it("matches names case-insensitively on Windows only", () => {
    const parent = { Path: "C:\\bin", SYSTEMROOT: "C:\\Windows", gh_token: "synthetic", Anthropic_Base_Url: "http://evil.invalid" };
    assert.deepEqual(
      buildProcessEnvironment({ parent, inheritance: { inherit: "allowlist", allow: ["ANTHROPIC_BASE_URL"] }, platform: "win32" }),
      { Path: "C:\\bin", SYSTEMROOT: "C:\\Windows", Anthropic_Base_Url: "http://evil.invalid" },
    );
    assert.deepEqual(
      buildProcessEnvironment({ parent, inheritance: { inherit: "allowlist", allow: ["ANTHROPIC_BASE_URL"] }, platform: "linux" }),
      {},
    );
  });
  it("lets an overlay replace a differently cased inherited name on Windows", () => {
    const parent = { Path: "C:\\bin", SystemRoot: "C:\\Windows" };
    for (const inheritance of [{ inherit: "all" as const }, { inherit: "allowlist" as const, allow: [] }]) {
      assert.deepEqual(
        buildProcessEnvironment({ parent, overlay: { PATH: "D:\\tools" }, inheritance, platform: "win32" }),
        { SystemRoot: "C:\\Windows", PATH: "D:\\tools" },
      );
    }
    // Elsewhere names are case-sensitive, so both stay.
    assert.deepEqual(
      buildProcessEnvironment({ parent, overlay: { PATH: "/tools" }, platform: "linux" }),
      { Path: "C:\\bin", SystemRoot: "C:\\Windows", PATH: "/tools" },
    );
  });
});

describe("execution record through record and replay", () => {
  it("replays the execution record of the run that produced the result", async () => {
    const recording = new RecordingModelRuntime(createClaudeCodeRuntime({
      model: "sonnet", executable, isolation: "safe-mode",
      environment: { RELAY_FAKE_DUMP: path.join(directory, "dump-replay.json") },
    }));
    const live = await recording.invoke(request);
    const replayed = await new ReplayModelRuntime(recording.records).invoke(request);
    assert.deepEqual(replayed.execution, live.execution);
    assert.deepEqual(replayed.execution?.isolationFlags, safeModeFlags);
  });
});
