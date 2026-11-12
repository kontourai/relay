import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createClaudeCodeRuntime, type ClaudeCodeRuntimeOptions } from "../src/claude-code.js";
import { PROCESS_ENVIRONMENT_BASE, buildProcessEnvironment } from "../src/process.js";
import { createModelRuntimeProfile } from "../src/runtime-profile.js";

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
fs.writeFileSync(process.env.RELAY_FAKE_DUMP, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  result: "ok", is_error: false, stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { "fixture-model": {} },
})));
`;

interface Dump { argv: string[]; env: Record<string, string> }

const request = { messages: [{ role: "user" as const, content: "synthetic excerpt" }] };
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
    assert.deepEqual(result.execution, { isolationFlags: [], environment: { inherit: "all" } });
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

  it("adds --safe-mode for safe-mode isolation and records the flag it passed", async () => {
    const { result, dump } = await run({ isolation: "safe-mode" });
    assert.deepEqual(dump.argv, [...defaultArgs, "--safe-mode"]);
    assert.deepEqual(result.execution?.isolationFlags, ["--safe-mode"]);
    const none = await run({ isolation: "none" });
    assert.deepEqual(none.dump.argv, defaultArgs);
  });

  it("rejects malformed policies at construction", () => {
    const build = (options: object) => () => createClaudeCodeRuntime({ model: "sonnet", ...options } as ClaudeCodeRuntimeOptions);
    assert.throws(build({ environmentInheritance: { inherit: "allowlist", allow: [""] } }), TypeError);
    assert.throws(build({ environmentInheritance: { inherit: "allowlist", allow: ["A=B"] } }), TypeError);
    assert.throws(build({ environmentInheritance: { inherit: "allowlist" } }), TypeError);
    assert.throws(build({ environmentInheritance: { inherit: "none" } }), TypeError);
    assert.throws(build({ isolation: "bare" }), TypeError);
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
    assert.deepEqual(dump.argv, [...defaultArgs, "--safe-mode"]);
    assert.deepEqual(result.execution?.isolationFlags, ["--safe-mode"]);
    assert.throws(() => createModelRuntimeProfile({ profile: "codex", model: "gpt-5", isolation: "safe-mode" }), /does not support isolation/);
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
});
