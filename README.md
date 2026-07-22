# Relay

Relay provides one provider-neutral way to invoke models across direct SDKs,
local engines, hosted services, and agent frameworks.

Relay carries an invocation; it does not decide which model to use or what a
response means. Bearing owns capability evidence, Datum owns configuration
resolution, and domain products retain their prompts and interpretation.

```text
Bearing -> Datum -> Relay -> Traverse / other domain consumers
```

## Core contract

```ts
import { FakeModelRuntime, checkRuntimeConformance } from "@kontourai/relay";

const runtime = new FakeModelRuntime([{
  provider: "fixture",
  model: "fixture-1",
  outputText: "",
  toolCalls: [{ id: "1", name: "submit", input: { value: 42 } }],
  usage: { totalTokens: 10 },
  latencyMs: 0,
}]);

const result = await runtime.invoke({
  messages: [{ role: "user", content: "Return a structured value." }],
  tools: [{ name: "submit", inputSchema: { type: "object" } }],
  toolChoice: { type: "tool", name: "submit" },
});

await checkRuntimeConformance(runtime);
```

## Process-backed harnesses

`@kontourai/relay/process` provides an abortable, output-bounded transport for
non-interactive model harnesses. A thin harness profile owns request encoding,
response parsing, typed failure classification, and an honest capability
declaration. The transport never interprets prompts, chooses a model, discovers
credentials, or copies constructor environment into results and errors.

```ts
import { createProcessRuntime } from "@kontourai/relay/process";

const runtime = createProcessRuntime({
  id: "my-harness",
  executable: "my-harness",
  capabilities: {
    structuredTools: false,
    streaming: false,
    abort: true,
    usage: false,
  },
  codec: {
    prepare: (request) => ({ args: ["run", "--json"], stdin: JSON.stringify(request) }),
    parse: (output) => normalizeHarnessOutput(output.stdout),
  },
});
```

Products should depend on `ModelRuntime`, not the process profile. This keeps a
single workload definition portable between a locally authenticated harness
and an SDK/API runtime selected later by the host or Dispatch. A profile must
report unsupported capabilities rather than silently approximating them.

### Claude Code profile

`@kontourai/relay/claude-code` uses Claude Code's non-interactive JSON output
and native JSON Schema validation. It supports text-only requests and exactly
one explicitly selected structured tool. Automatic tool choice and required
choice among multiple tools are rejected because the CLI cannot guarantee
those Relay semantics through its structured-output surface.

```ts
import { createClaudeCodeRuntime } from "@kontourai/relay/claude-code";

const localRuntime = createClaudeCodeRuntime({ model: "sonnet" });
```

Authentication remains owned by the installed harness. Relay does not inspect,
copy, or persist its credential configuration.

### Codex profile

`@kontourai/relay/codex` uses `codex exec` JSONL events and its native output
schema file. Relay creates the schema and a neutral default working directory
for one invocation, then removes both. A host may provide an explicit working
directory when repository context is intentionally part of the runtime target.

```ts
import { createCodexRuntime } from "@kontourai/relay/codex";

const localRuntime = createCodexRuntime({ model: "gpt-5" });
```

Like the Claude Code profile, Codex currently guarantees text or one explicitly
selected structured tool. Unsupported tool-selection semantics fail explicitly.

## Anthropic-compatible runtime

The optional `/anthropic` entrypoint loads `@anthropic-ai/sdk` only when a
client is not injected:

```ts
import { createAnthropicRuntime } from "@kontourai/relay/anthropic";

const runtime = createAnthropicRuntime({
  model: "claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
});
```

## AI SDK v3 framework adapter

The optional `/ai-sdk` entrypoint bridges Relay with frameworks that consume
the Vercel AI SDK v3 model contract. Both directions are supported:

```ts
import { createAiSdkModel, createAiSdkRuntime } from "@kontourai/relay/ai-sdk";

// Use an AI SDK provider model as a Relay candidate.
const candidateRuntime = createAiSdkRuntime({ model: providerModel });

// Give a Relay runtime— including a policy-backed runtime — to an AI SDK host.
const frameworkModel = createAiSdkModel({ runtime });
```

Text, function tools, tool selection, assistant tool calls, tool results,
usage, finish reasons, and abort signals cross the adapter. Provider-defined
tools, files, reasoning parts, approval parts, sampling controls, response
formats, seeds, and provider-specific options are not portable in the current
Relay contract and produce an explicit warning or typed invalid-request error.

Relay v0.2 has no native streaming contract. `createAiSdkModel()` therefore
buffers one Relay invocation and emits a valid compatibility stream afterward;
the stream includes a compatibility warning and must not be described as live
token streaming.

Credentials are adapter-construction data and must never be placed in Relay
requests, results, replay records, or conformance reports. Recording captures
request content by design, so hosts must apply their own content-handling policy.

## Boundaries

Relay does not own model selection, credential storage, extraction, review,
workflow, trust, agent personas, or application tools. See [CONTEXT.md](CONTEXT.md).
