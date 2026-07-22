import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexCodec, createCodexRuntime } from "../src/codex.js";
import { ModelInvocationError, type ModelInvocationRequest } from "../src/types.js";

const request: ModelInvocationRequest = {
  messages: [{ role: "user", content: "Camp Alpha has 40 openings." }],
  tools: [{ name: "submit", inputSchema: { type: "object", properties: { openings: { type: "number" } }, required: ["openings"] } }],
  toolChoice: { type: "tool", name: "submit" },
};

test("Codex profile projects forced structured output through an invocation schema file", () => {
  const codec = createCodexCodec("gpt-5", "/private/tmp/output.schema.json");
  const invocation = codec.prepare(request);
  assert.deepEqual(invocation.args.slice(0, 5), ["--ask-for-approval", "never", "exec", "--json", "--ephemeral"]);
  assert.ok(invocation.args.includes("--skip-git-repo-check"));
  assert.ok(invocation.args.includes("--ignore-rules"));
  assert.equal(invocation.args[invocation.args.indexOf("--output-schema") + 1], "/private/tmp/output.schema.json");
  assert.equal(invocation.args.at(-1), "-");

  const result = codec.parse({
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: "fixture" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ openings: 40 }) } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 3 } }),
    ].join("\n"),
    stderr: "",
    exitCode: 0,
    latencyMs: 14,
  }, request);
  assert.deepEqual(result.toolCalls, [{ id: "codex-structured-output", name: "submit", input: { openings: 40 } }]);
  assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 3, totalTokens: 12 });
});

test("Codex profile rejects unsupported automatic tool choice", () => {
  const codec = createCodexCodec("gpt-5", "/tmp/schema.json");
  assert.throws(() => codec.prepare({ ...request, toolChoice: { type: "auto" } }), (error: unknown) =>
    error instanceof ModelInvocationError && error.code === "INVALID_REQUEST");
});

test("Codex profile rejects malformed JSONL and structured output", () => {
  const codec = createCodexCodec("gpt-5", "/tmp/schema.json");
  assert.throws(() => codec.parse({ stdout: "not-json", stderr: "", exitCode: 0, latencyMs: 1 }, request), (error: unknown) =>
    error instanceof ModelInvocationError && error.code === "RUNTIME_FAILURE");
  assert.throws(() => codec.parse({
    stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "not-json" } }),
    stderr: "",
    exitCode: 0,
    latencyMs: 1,
  }, request), (error: unknown) => error instanceof ModelInvocationError && error.code === "RUNTIME_FAILURE");
});

test("Codex runtime creates and removes an invocation-scoped schema", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "relay-codex-fixture-"));
  const executable = path.join(fixtureRoot, "codex-fixture.mjs");
  const recordPath = path.join(fixtureRoot, "schema-path.txt");
  await writeFile(executable, `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
const schemaIndex = process.argv.indexOf("--output-schema");
const schemaPath = process.argv[schemaIndex + 1];
JSON.parse(await readFile(schemaPath, "utf8"));
await writeFile(process.env.RELAY_CODEX_SCHEMA_RECORD, schemaPath, "utf8");
process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({openings:40})}}) + "\\n");
process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:2,output_tokens:1}}) + "\\n");
`, { encoding: "utf8", mode: 0o700 });
  await chmod(executable, 0o700);
  try {
    const runtime = createCodexRuntime({
      model: "fixture-model",
      executable,
      environment: { RELAY_CODEX_SCHEMA_RECORD: recordPath },
    });
    const result = await runtime.invoke(request);
    assert.deepEqual(result.toolCalls[0]?.input, { openings: 40 });
    const schemaPath = await readFile(recordPath, "utf8");
    await assert.rejects(access(schemaPath), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
