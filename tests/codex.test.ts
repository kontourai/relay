import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexCodec, createCodexRuntime } from "../src/codex.js";
import { ModelInvocationError, type ModelInvocationRequest } from "../src/types.js";

const request: ModelInvocationRequest = {
  messages: [{ role: "user", content: "Camp Alpha has 40 openings." }],
  tools: [{ name: "submit", inputSchema: { type: "object", additionalProperties: false, properties: { openings: { type: "number" } }, required: ["openings"] } }],
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
    assert.deepEqual([result.model, result.modelSource], ["fixture-model", "configured"]);
    const schemaPath = await readFile(recordPath, "utf8");
    await assert.rejects(access(schemaPath), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("Codex runtime reports nested schema incompatibilities before launch without mutating the caller schema", async () => {
  const schemas = [
    {
      schema: { type: "object", properties: {}, required: [] },
      expected: /at #: object schemas require additionalProperties: false/,
    },
    {
      schema: {
        type: "object", additionalProperties: false, required: ["rows"], properties: {
          rows: { type: "array", items: { type: "object", additionalProperties: false, required: ["value"], properties: { value: {} } } },
        },
      },
      expected: /#\/properties\/rows\/items\/properties\/value: unconstrained schemas are not supported/,
    },
    {
      schema: {
        type: "object", additionalProperties: false, required: [], properties: { note: { type: ["string", "null"] } },
      },
      expected: /#\/properties\/note: properties must be required/,
    },
  ] as const;

  for (const fixture of schemas) {
    const original = JSON.stringify(fixture.schema);
    const runtime = createCodexRuntime({ model: "fixture", executable: "/must-not-run" });
    await assert.rejects(runtime.invoke({
      messages: request.messages,
      tools: [{ name: "submit", inputSchema: fixture.schema }],
      toolChoice: { type: "tool", name: "submit" },
    }), (error: unknown) => error instanceof ModelInvocationError
      && error.code === "INVALID_REQUEST"
      && fixture.expected.test(error.message));
    assert.equal(JSON.stringify(fixture.schema), original);
  }
});

test("Codex runtime accepts strict nested arrays and nullable required fields", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "relay-codex-strict-fixture-"));
  const executable = path.join(fixtureRoot, "codex-fixture.mjs");
  await writeFile(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({rows:[{note:null}]})}}) + "\\n");
`, { encoding: "utf8", mode: 0o700 });
  await chmod(executable, 0o700);
  try {
    const runtime = createCodexRuntime({ model: "fixture", executable });
    const result = await runtime.invoke({
      messages: request.messages,
      tools: [{ name: "submit", inputSchema: {
        type: "object", additionalProperties: false, required: ["rows"], properties: {
          rows: { type: "array", items: {
            type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: ["string", "null"] } },
          } },
        },
      } }],
      toolChoice: { type: "tool", name: "submit" },
    });
    assert.deepEqual(result.toolCalls[0]?.input, { rows: [{ note: null }] });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

const describedRequest: ModelInvocationRequest = {
  messages: [{ role: "user", content: "Camp Alpha has 40 openings." }],
  tools: [{
    name: "submit",
    description: "Report openings exactly as written.",
    inputSchema: { type: "object", additionalProperties: false, properties: { openings: { type: "number", description: "Seats still open." } }, required: ["openings"] },
  }],
  toolChoice: { type: "tool", name: "submit" },
};
const describedPrompt = [
  "Process the following provider-neutral conversation. Preserve the roles and return only the requested response.",
  "Description of the submit result:\nReport openings exactly as written.",
  "Field descriptions for the submit result:\n- openings: Seats still open.",
  "{\"messages\":[{\"role\":\"user\",\"content\":\"Camp Alpha has 40 openings.\"}]}",
].join("\n\n");

test("Codex prompt carries the tool description and field descriptions", () => {
  const invocation = createCodexCodec("gpt-5", "/private/tmp/output.schema.json").prepare(describedRequest);
  assert.equal(invocation.stdin, describedPrompt);
  assert.deepEqual(invocation.args, [
    "--ask-for-approval", "never", "exec", "--json", "--ephemeral", "--color", "never", "--sandbox", "read-only",
    "--skip-git-repo-check", "--ignore-rules", "--model", "gpt-5", "--output-schema", "/private/tmp/output.schema.json", "-",
  ]);
  // Without descriptions the prompt is the conversation alone.
  assert.equal(createCodexCodec("gpt-5", "/private/tmp/output.schema.json").prepare(request).stdin, [
    "Process the following provider-neutral conversation. Preserve the roles and return only the requested response.",
    "{\"messages\":[{\"role\":\"user\",\"content\":\"Camp Alpha has 40 openings.\"}]}",
  ].join("\n\n"));
});

test("Codex runtime delivers the description prompt and the described schema to the process", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "relay-codex-description-"));
  const executable = path.join(fixtureRoot, "codex-fixture.mjs");
  const recordPath = path.join(fixtureRoot, "received.json");
  await writeFile(executable, `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
const schema = await readFile(process.argv[process.argv.indexOf("--output-schema") + 1], "utf8");
await writeFile(process.env.RELAY_CODEX_RECORD, JSON.stringify({ stdin, schema }), "utf8");
process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({openings:40})}}) + "\\n");
`, { encoding: "utf8", mode: 0o700 });
  await chmod(executable, 0o700);
  try {
    const runtime = createCodexRuntime({ model: "fixture", executable, environment: { RELAY_CODEX_RECORD: recordPath } });
    await runtime.invoke(describedRequest);
    const received = JSON.parse(await readFile(recordPath, "utf8")) as { stdin: string; schema: string };
    assert.equal(received.stdin, describedPrompt);
    assert.deepEqual(JSON.parse(received.schema), describedRequest.tools?.[0]?.inputSchema);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

// Event shapes as \`codex exec --json\` prints a failed turn (exit code 1, empty stderr).
const limitMessage = "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Oct 4th, 2026 9:00 AM.";
const limitStdout = [
  JSON.stringify({ type: "thread.started", thread_id: "fixture" }),
  JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "user (/Users/someone/.codex/config.toml): `env` is ignored." } }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "error", message: limitMessage }),
  JSON.stringify({ type: "turn.failed", error: { message: limitMessage } }),
].join("\n");

test("Codex classifies a usage-limit turn as a non-retryable rate limit with a reason", async () => {
  const codec = createCodexCodec("gpt-5", "/tmp/schema.json");
  const error = codec.classifyFailure?.({ stdout: limitStdout, stderr: "", exitCode: 1, latencyMs: 1 }, request);
  assert.deepEqual([error?.code, error?.message, error?.retryable],
    ["RATE_LIMITED", "Codex rate limited: usage limit reached; resets Oct 4th, 2026 9:00 AM", false]);
  const retries = codec.classifyFailure?.({
    stdout: JSON.stringify({ type: "turn.failed", error: { message: "exceeded retry limit, last status: 429 Too Many Requests" } }),
    stderr: "", exitCode: 1, latencyMs: 1,
  }, request);
  assert.deepEqual([retries?.code, retries?.message, retries?.retryable], ["RATE_LIMITED", "Codex rate limited: rate limit reached", false]);
  // A failed turn reported with a zero exit code must not read as a missing message.
  assert.throws(() => codec.parse({ stdout: limitStdout, stderr: "", exitCode: 0, latencyMs: 1 }, request), (thrown: unknown) =>
    thrown instanceof ModelInvocationError && thrown.code === "RATE_LIMITED" && !thrown.retryable);

  // Through the runtime: a nonzero exit reaches the same classification.
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "relay-codex-limit-"));
  const executable = path.join(fixtureRoot, "codex-fixture.mjs");
  await writeFile(executable, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(limitStdout)} + "\\n");
process.exitCode = 1;
`, { encoding: "utf8", mode: 0o700 });
  await chmod(executable, 0o700);
  try {
    await assert.rejects(createCodexRuntime({ model: "fixture", executable }).invoke(request), (thrown: unknown) =>
      thrown instanceof ModelInvocationError && thrown.code === "RATE_LIMITED" && !thrown.retryable
      && thrown.message === "Codex rate limited: usage limit reached; resets Oct 4th, 2026 9:00 AM");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("Codex does not read a limit from an agent message or an unrelated failure", () => {
  const codec = createCodexCodec("gpt-5", "/tmp/schema.json");
  const error = codec.classifyFailure?.({
    stdout: [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "You've hit your usage limit" } }),
      JSON.stringify({ type: "turn.failed", error: { message: "The model is not supported." } }),
    ].join("\n"),
    stderr: "", exitCode: 1, latencyMs: 1,
  }, request);
  assert.deepEqual([error?.code, error?.message], ["RUNTIME_FAILURE", "Codex failed with exit code 1"]);
});
