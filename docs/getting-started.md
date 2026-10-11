# Getting started

This page installs Relay, runs a first invocation against a deterministic fake
runtime, and then swaps in a real runtime without changing the workload. For
what each piece is, read [Concepts](concepts.md). For every export and option,
read the [Reference](reference.md).

## Install

Relay is published to npm as `@kontourai/relay`. It is an ES module package
(`"type": "module"`, `import` exports only) and requires Node 22 or newer.

```sh
npm install @kontourai/relay
```

Peer dependencies:

- `@ai-sdk/provider` (`>=3.0.0`) supplies the types used by the
  `@kontourai/relay/ai-sdk` entrypoint.
- `@anthropic-ai/sdk` (`>=0.40.0`) is optional. The
  `@kontourai/relay/anthropic` entrypoint loads it only when you do not inject
  your own client. Install it if you use that runtime without a client.

The local harness runtimes (`claude-code`, `codex`, `opencode`) need the
matching CLI installed and already authenticated. Relay runs the executable;
it never installs it or manages its login.

## First invocation

Products depend on the `ModelRuntime` interface. `FakeModelRuntime` implements
it with a queue of prepared results, so you can write and test the workload
before choosing a real runtime.

```ts
import { FakeModelRuntime } from "@kontourai/relay";

const runtime = new FakeModelRuntime([{
  provider: "fixture",
  model: "fixture-1",
  modelSource: "configured",
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

console.log(result.toolCalls[0]?.input); // { value: 42 }
```

Each `invoke()` takes the next queued result. When the queue is empty, the fake
throws a `RUNTIME_FAILURE`. It also records every request it received in
`runtime.requests`, which is useful for asserting what your code sent.

## Check a runtime's contract

`checkRuntimeConformance()` reads the runtime's declared capabilities, makes
one small invocation, and returns a report instead of throwing.

```ts
import { checkRuntimeConformance } from "@kontourai/relay";

const report = await checkRuntimeConformance(runtime);
if (!report.passed) console.error(report.checks.filter((check) => !check.passed));
```

The invocation is real. Against a hosted or harness runtime it calls the model
once, with a one-word prompt and `maxOutputTokens: 1`.

## Use a real runtime

The workload above does not change when the runtime does. Pick one entrypoint:

```ts
// A locally authenticated Claude Code CLI.
import { createClaudeCodeRuntime } from "@kontourai/relay/claude-code";
const runtime = createClaudeCodeRuntime({ model: "sonnet" });
```

```ts
// The Anthropic Messages API, or any Anthropic-compatible endpoint.
import { createAnthropicRuntime } from "@kontourai/relay/anthropic";
const runtime = createAnthropicRuntime({
  model: "claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
});
```

```ts
// One runtime chosen by a "PROFILE:MODEL" string, for example from configuration.
import { createModelRuntimeProfile, parseModelRuntimeProfile } from "@kontourai/relay/runtime-profile";
const runtime = createModelRuntimeProfile({
  ...parseModelRuntimeProfile("codex:gpt-5"),
  cwd: process.cwd(),
});
```

The harness runtimes accept text-only requests and requests with exactly one
explicitly selected tool. A request with tools and no `toolChoice`, or with
`toolChoice: { type: "auto" }`, is refused with `INVALID_REQUEST`. The
[runtime comparison](reference.md#runtime-comparison) lists what each runtime
supports.

## Handle failures

Every runtime rejects with a `ModelInvocationError`. Branch on its `code` and
`retryable` flag rather than on the message text.

```ts
import { ModelInvocationError } from "@kontourai/relay";

try {
  await runtime.invoke(request);
} catch (error) {
  if (error instanceof ModelInvocationError && error.retryable) {
    // RATE_LIMITED or PROVIDER_UNAVAILABLE: try again later or use another runtime.
  }
  throw error;
}
```

Relay itself never retries. The Anthropic runtime even turns off the SDK's own
retries by default, so the caller is the only component that decides whether
to try again. See [Failures and retryability](concepts.md#failures-and-retryability).

## Record and replay

Wrap a runtime in `RecordingModelRuntime` to capture its invocations, then
serve them back with `ReplayModelRuntime` in tests that must not call a model.

```ts
import { RecordingModelRuntime, ReplayModelRuntime } from "@kontourai/relay";

const recording = new RecordingModelRuntime(runtime);
await recording.invoke(request);

const replay = new ReplayModelRuntime(recording.records);
await replay.invoke(request); // the recorded result
```

Records contain the full request and result, prompt content included. Apply
your own content-handling policy before you store them.

## Next steps

- [Concepts](concepts.md) explains runtimes, capabilities, model identity, and
  failures.
- [Reference](reference.md) documents every entrypoint and option.
- [Domain language](../CONTEXT.md) defines Relay's terms and its boundaries with
  other Kontour products.
