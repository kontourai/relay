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

Credentials are adapter-construction data and must never be placed in Relay
requests, results, replay records, or conformance reports. Recording captures
request content by design, so hosts must apply their own content-handling policy.

## Boundaries

Relay does not own model selection, credential storage, extraction, review,
workflow, trust, agent personas, or application tools. See [CONTEXT.md](CONTEXT.md).
