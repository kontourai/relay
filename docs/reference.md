# Reference

Relay's public surface is its package entrypoints. There is no command-line
tool. Each section below lists one entrypoint's exports and options; the
behaviour they share is explained in [Concepts](concepts.md).

## Entrypoints

| Import | Contents | Extra requirement |
| --- | --- | --- |
| `@kontourai/relay` | Core types, `ModelInvocationError`, fake, recording and replay runtimes, conformance checks, digests | None |
| `@kontourai/relay/process` | `createProcessRuntime` and the codec types | None |
| `@kontourai/relay/claude-code` | `createClaudeCodeRuntime`, `createClaudeCodeCodec` | The `claude` CLI |
| `@kontourai/relay/codex` | `createCodexRuntime`, `createCodexCodec` | The `codex` CLI |
| `@kontourai/relay/opencode` | `createOpenCodeRuntime`, `createOpenCodeCodec` | The `opencode` CLI |
| `@kontourai/relay/anthropic` | `createAnthropicRuntime` | `@anthropic-ai/sdk`, unless you inject a client |
| `@kontourai/relay/ai-sdk` | `createAiSdkRuntime`, `createAiSdkModel` | `@ai-sdk/provider` types and an AI SDK v3 model or host |
| `@kontourai/relay/runtime-profile` | `MODEL_RUNTIME_PROFILES`, `parseModelRuntimeProfile`, `createModelRuntimeProfile` | Whatever the chosen profile needs |

## Runtime comparison

| Runtime | `id` | Text | Structured tools | Tool choice | `maxOutputTokens` | Model source |
| --- | --- | --- | --- | --- | --- | --- |
| Anthropic-compatible | `<provider>:<model>` | yes | native | `auto`, `required`, `tool` | sent as `max_tokens` | provider-reported when the response has a model |
| AI SDK | `<provider>:<modelId>`, or `id` | yes | native | `auto`, `required`, `tool` | passed through | provider-reported when the model reports one |
| Claude Code | `claude-code:<model>` | yes | native, one selected tool | `tool`, or `required` with one tool | not enforced; a warning when exceeded | provider-reported when unambiguous |
| Codex | `codex:<model>` | yes | native, one selected tool | `tool`, or `required` with one tool | not enforced | configured |
| OpenCode | `opencode:<model>` | yes | refused by default; prompted when opted in | `tool`, or `required` with one tool | not enforced | configured |

None of these runtimes streams or offers a physical batch, and all of them
honour an abort signal.

## Core types

Exported as types from `@kontourai/relay`.

| Type | Shape |
| --- | --- |
| `ModelRuntime` | `id`, `capabilities()`, `invoke(request, options?)`, optional `invokeBatch(requests, options?)` |
| `ModelInvocationRequest` | `messages`, optional `tools`, `toolChoice`, `maxOutputTokens`, `metadata` |
| `ModelMessage` | `role`: `system`, `user`, `assistant`, or `tool`; `content`: a string or `ModelMessageContentPart[]` |
| `ModelMessageContentPart` | `{ type: "text", text }`, `{ type: "tool-call", id, name, input }`, or `{ type: "tool-result", id, name, output, isError? }` |
| `ModelTool` | `name`, optional `description`, `inputSchema` |
| `ModelToolChoice` | `{ type: "auto" }`, `{ type: "required" }`, or `{ type: "tool", name }` |
| `ModelInvocationResult` | `provider`, `model`, `modelSource?`, `outputText`, `toolCalls`, `usage`, `latencyMs`, `stopReason?`, `warnings?` |
| `ModelSource` | `"provider-reported"` or `"configured"` |
| `ModelToolCall` | `id`, `name`, `input` |
| `ModelUsage` | Optional `inputTokens`, `outputTokens`, `totalTokens`, `cacheReadTokens`, `cacheWriteTokens`, `costUsd` |
| `ModelRuntimeCapabilities` | `structuredTools`, `streaming`, `abort`, `usage`; optional `structuredToolsFidelity`, `outputTokenLimitFidelity`, `physicalBatch`, `maxBatchSize` |
| `ModelInvocationOptions` | Optional `signal: AbortSignal` |
| `ModelInvocationFailure` | `code`, `message`, `retryable`: a content-free failure for one batch item |
| `ModelBatchInvocationOutcome` | `{ status: "fulfilled", value }` or `{ status: "rejected", reason }` |
| `ModelInvocationErrorCode` | `ABORTED`, `AUTHENTICATION_FAILED`, `INVALID_REQUEST`, `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `RUNTIME_FAILURE` |
| `JsonSchema` | `Readonly<Record<string, unknown>>` |
| `InvocationReplayRecord` | `schemaVersion: 1`, `requestDigest`, `request`, `result` |
| `RuntimeConformanceReport`, `PhysicalBatchConformanceReport` | `runtimeId`, `passed`, `checks: { name, passed, detail }[]` |

`ModelInvocationError` is a class: `new ModelInvocationError(code, message,
retryable, options?)`. Its `name` is `"ModelInvocationError"`, and it exposes
`code` and `retryable` as read-only properties. The codes are explained in
[Failures and retryability](concepts.md#failures-and-retryability).

## Test and replay runtimes

Exported from `@kontourai/relay`.

### FakeModelRuntime

`new FakeModelRuntime(results, id = "fake")`

- `results` is a queue of `ModelInvocationResult` or `ModelInvocationFailure`
  values. Each `invoke()` takes the next one. A failure entry is thrown as a
  `ModelInvocationError` with its code, message, and `retryable` flag. An empty
  queue throws `RUNTIME_FAILURE`.
- `invokeBatch()` takes one queued outcome per request and returns failures as
  rejected items. It accepts 1 to 100 requests and throws `INVALID_REQUEST`
  otherwise. An item with no queued outcome is rejected with
  `RUNTIME_FAILURE`.
- Capabilities: native structured tools and output limit, abort, usage,
  `physicalBatch: true`, `maxBatchSize: 100`, no streaming.
- Inspection: `requests` (every request, from `invoke` and `invokeBatch`),
  `batchRequests` (one array per batch), and `physicalInvocationCount`.
- An already-aborted signal throws `ABORTED`.

### RecordingModelRuntime

`new RecordingModelRuntime(runtime)`

- `id` is `recording:<wrapped id>`.
- `capabilities()` returns the wrapped runtime's capabilities without
  `physicalBatch` and `maxBatchSize`, because the recorder has no
  `invokeBatch()`.
- After each successful `invoke()`, appends a frozen `InvocationReplayRecord`
  to `records`. Failed invocations are not recorded.

### ReplayModelRuntime

`new ReplayModelRuntime(records)`

- `id` is `replay`.
- `invoke()` returns a copy of the result whose record has the same
  `requestDigest` as the request. A request with no match throws
  `INVALID_REQUEST` (`No replay record matches this invocation`).
- Capabilities: native structured tools and output limit, abort, usage, no
  streaming.

### Digests

- `canonicalJson(value)`: `JSON.stringify` with object keys sorted at every
  level.
- `invocationDigest(value)`: `sha256:` followed by the hex SHA-256 of
  `canonicalJson(value)`.

## Conformance checks

Exported from `@kontourai/relay`. Both return a frozen report and do not throw
for a failed check.

### checkRuntimeConformance

`checkRuntimeConformance(runtime): Promise<RuntimeConformanceReport>`

Invokes the runtime once with `{ messages: [{ role: "user", content:
"relay-conformance" }], maxOutputTokens: 1 }`. Against a real runtime this is a
real model call. The checks are:

| Check | Passes when |
| --- | --- |
| `capabilities` | `abort` is a boolean. |
| `physical-batch-declaration` | With `physicalBatch: true`, `invokeBatch` exists and `maxBatchSize` is a positive integer. Otherwise `invokeBatch` is absent and `maxBatchSize` is undefined. |
| `structured-tools-fidelity` | Undeclared, or `native`/`prompted` with `structuredTools: true`, or `unavailable` with `structuredTools: false`. |
| `output-token-limit-fidelity` | Undeclared, or one of `native`, `approximated`, `unavailable`. |
| `identity` | The result has a non-empty `provider` and `model`. |
| `model-source` | `modelSource` is `provider-reported` or `configured`. |
| `shape` | `toolCalls` is an array and `latencyMs` is at least 0. |
| `invoke` | Present only when the invocation threw; always fails, with the error message as detail. |

### checkPhysicalBatchConformance

`checkPhysicalBatchConformance(runtime, requests, options?): Promise<PhysicalBatchConformanceReport>`

`options` accepts `signal` and `requireMixedOutcomes`. The batch is issued only
when the first two checks pass.

| Check | Passes when |
| --- | --- |
| `physical-batch-declaration` | `physicalBatch: true`, `invokeBatch` exists, and `maxBatchSize` is a positive integer. |
| `request-count` | `requests` is non-empty and no larger than `maxBatchSize`. |
| `positional-correspondence` | The batch returned one outcome per request. |
| `typed-outcomes` | Every outcome is `fulfilled` or `rejected`. |
| `partial-item-failure` | Only with `requireMixedOutcomes`: at least one fulfilled and one rejected outcome. |
| `invoke-batch` | Present only when `invokeBatch` rejected; always fails, with the error's `name` as detail. |

## Process transport

`createProcessRuntime(options): ModelRuntime` from `@kontourai/relay/process`.

| Option | Meaning |
| --- | --- |
| `id` | The runtime `id`. |
| `executable` | The command to spawn. |
| `capabilities` | The declaration returned by `capabilities()`. |
| `codec` | A `ProcessRuntimeCodec`: `prepare(request)` returns `{ args, stdin? }`; `parse(output, request)` returns a result; optional `classifyFailure(output, request)` returns a `ModelInvocationError` for a nonzero exit. |
| `cwd` | Working directory for the child process. |
| `environment` | Variables added on top of the parent's `process.env` for the child. Never copied into results or errors. |
| `maxOutputBytes` | Combined stdout and stderr limit. Default 8 MiB. |
| `now` | Clock for `latencyMs`. Default `performance.now()`. |

The `output` passed to the codec is `{ stdout, stderr, exitCode, latencyMs }`.

Failure behaviour:

- A signal that is already aborted, or aborts while the child runs, throws
  `ABORTED`. A running child is sent `SIGTERM`.
- `prepare()` throwing anything other than a `ModelInvocationError` becomes
  `INVALID_REQUEST`.
- A missing executable (`ENOENT`) is a retryable `PROVIDER_UNAVAILABLE`. Any
  other spawn error is `RUNTIME_FAILURE`.
- Output beyond `maxOutputBytes` is `RUNTIME_FAILURE` and the child is
  terminated.
- A nonzero exit uses `classifyFailure()`, or `RUNTIME_FAILURE` naming the exit
  code when there is none.
- `parse()` throwing anything other than a `ModelInvocationError` becomes
  `RUNTIME_FAILURE`.

## Claude Code runtime

`createClaudeCodeRuntime(options)` from `@kontourai/relay/claude-code`.

| Option | Meaning |
| --- | --- |
| `model` | Passed to `--model`. Required. |
| `executable` | Default `claude`. |
| `cwd`, `environment`, `maxOutputBytes` | As for the process transport. |

It runs `claude --print --output-format json --model <model>
--no-session-persistence --tools "" --permission-mode dontAsk`, adding
`--json-schema <schema>` when a tool is selected. The conversation is sent on
stdin as JSON, after a fixed instruction line and any tool and field
descriptions.

- A selected tool's result is `toolCalls[0]` with id
  `claude-code-structured-output`, taken from the CLI's `structured_output`. If
  that field is missing, the invocation fails with `RUNTIME_FAILURE`.
- Usage maps `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, and `total_cost_usd` when present.
- `outputTokenLimitFidelity` is `unavailable`. When the CLI reports more output
  tokens than `maxOutputTokens`, the result carries the warning
  `OUTPUT_TOKEN_LIMIT_NOT_ENFORCED: requested <n>, observed <m>`.
- `createClaudeCodeCodec(model)` is exported for profile conformance fixtures.
  Applications should construct the runtime.

## Codex runtime

`createCodexRuntime(options)` from `@kontourai/relay/codex`.

| Option | Meaning |
| --- | --- |
| `model` | Passed to `--model`. Required. |
| `executable` | Default `codex`. |
| `cwd` | Working directory. Default: a fresh temporary directory, removed after the invocation. Set it when repository context is intentionally part of the runtime target. |
| `environment`, `maxOutputBytes` | As for the process transport. |

It runs `codex --ask-for-approval never exec --json --ephemeral --color never
--sandbox read-only --skip-git-repo-check --ignore-rules --model <model> -`,
adding `--output-schema <file>` when a tool is selected. Relay writes that
schema file into the temporary directory and removes it afterwards.

The selected tool's `inputSchema` must meet Codex's output-schema rules, or the
invocation fails with `INVALID_REQUEST` naming the JSON pointer:

- Every schema node Relay visits (the root, properties, `items`, combinator
  branches, and definitions) is a non-empty object.
- An object schema (`type: "object"` or `properties`) has
  `additionalProperties: false`, a `properties` object, and lists every
  property in `required`. Express an optional value with a nullable schema.
- An array schema (`type: "array"` or `items`) has `items`.
- `anyOf`, `oneOf`, and `allOf` hold at least one schema; `$defs` and
  `definitions` are objects.

The result text is the last `agent_message` event. With a selected tool, that
text is parsed as JSON into `toolCalls[0]` (id `codex-structured-output`) and
`outputText` is empty. Usage comes from the last `turn.completed` event, and
`stopReason` is `completed`. `createCodexCodec(model, schemaPath?)` is exported
for fixtures.

## OpenCode runtime

`createOpenCodeRuntime(options)` from `@kontourai/relay/opencode`.

| Option | Meaning |
| --- | --- |
| `model` | An OpenCode `provider/model` identifier, such as `zai/glm-5`. Required. |
| `structuredOutput` | `"reject"` (default) refuses any request with tools. `"prompted"` puts the selected tool's schema in the prompt. |
| `executable` | Default `opencode`. |
| `cwd` | Working directory. Default: a fresh temporary directory, removed after the invocation. |
| `environment`, `maxOutputBytes` | As for the process transport. |

It runs `opencode --pure run --format json --model <model>` and joins the text
of every `text` event. Usage and `stopReason` come from the last step-finish
event.

In prompted mode the response text, with one surrounding Markdown code fence
removed, is parsed as JSON into `toolCalls[0]` (id `opencode-prompted-output`),
and the result carries the warning `Structured output was prompt-enforced, not
schema-enforced by OpenCode.` Unparseable JSON fails with a retryable
`RUNTIME_FAILURE`. `createOpenCodeCodec(model, structuredOutput?)` is exported
for fixtures.

## Anthropic runtime

`createAnthropicRuntime(options)` from `@kontourai/relay/anthropic`.

| Option | Meaning |
| --- | --- |
| `model` | The model sent to the Messages API. Required. |
| `apiKey` | API key. When neither `apiKey` nor `client` is given, `ANTHROPIC_API_KEY` from the environment is used; with no key at all, the invocation fails with `AUTHENTICATION_FAILED`. |
| `baseUrl` | Base URL for an Anthropic-compatible endpoint. |
| `client` | An injected object with `create(params, { signal })`. When given, the SDK is not loaded and `apiKey`, `baseUrl`, `maxRetries`, and `timeoutMs` are ignored. |
| `provider` | The result's `provider` and the `id` prefix. Default `anthropic-compatible`. |
| `defaultMaxOutputTokens` | `max_tokens` when the request has no `maxOutputTokens`. Default 2048. |
| `maxRetries` | SDK retries per invocation. Default 0, so one `invoke()` is one provider request. |
| `timeoutMs` | Per-request SDK timeout. Unset keeps the SDK default. A timeout is a retryable `PROVIDER_UNAVAILABLE`. |
| `now` | Clock for `latencyMs`. |

Request mapping: `system` messages are joined with blank lines into `system`;
`tool` messages are sent as `user` messages; tool results become `tool_result`
blocks. `toolChoice` maps to `tool`, `any` (for `required`), or `auto`. The
result's `model` is the response's model, reported as `provider-reported`; if
the response has no model, the configured model is reported as `configured`.
Text blocks are joined with newlines.

## AI SDK bridge

From `@kontourai/relay/ai-sdk`. It works in both directions with the Vercel AI
SDK v3 model contract (`LanguageModelV3`).

### createAiSdkRuntime

`createAiSdkRuntime({ model, id?, now? }): ModelRuntime` uses an AI SDK provider
model as a Relay runtime.

- `id` defaults to `<model.provider>:<model.modelId>`.
- Text, function tools, tool choice, assistant tool calls, tool results,
  `maxOutputTokens`, and the abort signal are passed to `doGenerate()`.
- A Relay `user` message may contain only text, and a `tool` message only
  tool results; anything else is `INVALID_REQUEST`.
- The AI SDK's warnings are returned as strings in `result.warnings`.

### createAiSdkModel

`createAiSdkModel({ runtime, provider?, modelId? }): LanguageModelV3` gives any
Relay runtime to an AI SDK host.

- `provider` defaults to `relay`, and `modelId` to the runtime's `id`.
- Provider-defined tools and non-text, non-tool prompt parts are refused with
  `INVALID_REQUEST`.
- Sampling and format options (`temperature`, `stopSequences`, `topP`, `topK`,
  `presencePenalty`, `frequencyPenalty`, `responseFormat`, `seed`,
  `providerOptions`) and `tool.strict` are not portable and produce an
  `unsupported` warning. `toolChoice: none` drops the tools, with a warning.
- Relay warnings come back as `unsupported` warnings with feature `runtime`.
- `doStream()` buffers one Relay invocation, then emits it as a stream whose
  `stream-start` part carries a `compatibility` warning for `streaming`. It is
  not live token streaming.

## Runtime profile entrypoint

From `@kontourai/relay/runtime-profile`.

- `MODEL_RUNTIME_PROFILES`: `["claude-code", "codex", "opencode", "anthropic"]`.
- `parseModelRuntimeProfile(value)` splits `PROFILE:MODEL` at the first colon,
  so the model may itself contain colons. It returns a frozen `{ profile, model
  }` and throws a plain `Error` for a missing part (`runtime profile must use
  PROFILE:MODEL`) or an unknown profile (`unknown runtime profile: <name>`).
- `createModelRuntimeProfile(options)` constructs one runtime.

| Option | Applies to | Meaning |
| --- | --- | --- |
| `profile`, `model` | all | Usually spread from `parseModelRuntimeProfile()`. |
| `executable`, `cwd`, `environment`, `maxOutputBytes` | `claude-code`, `codex`, `opencode` | Forwarded to the runtime. |
| `allowPromptedStructuredOutput` | `opencode` | Required. Without it, construction throws. The runtime is always built with `structuredOutput: "prompted"`. |
| `apiKey` | `anthropic` | Required. Without it, construction throws. The resolver never reads the environment. |
| `baseUrl`, `maxRetries`, `timeoutMs` | `anthropic` | Forwarded to the runtime. |

## Troubleshooting

Common failures and what they mean. The message text is the `message` of the
`ModelInvocationError`, or of the plain `Error` for the profile resolver.

| Message | Cause and fix |
| --- | --- |
| `<Harness> profile requires an explicit tool choice` | A harness runtime received tools with no `toolChoice` or with `auto`. Select one tool with `{ type: "tool", name }`. |
| `Required tool choice needs exactly one declared tool` | `{ type: "required" }` was used with several tools on a harness runtime. Declare one tool or name it. |
| `Selected tool is not declared` | `toolChoice.name` does not match any tool in `tools`. |
| `Tool choice requires a declared tool` | Claude Code or Codex received a non-`auto` `toolChoice` with no tools. |
| `OpenCode structured output requires explicit prompted opt-in` | `createOpenCodeRuntime()` received tools while `structuredOutput` is `"reject"`. Pass `structuredOutput: "prompted"`. |
| `opencode structured tools require explicit prompted-output opt-in` | `createModelRuntimeProfile()` was given the `opencode` profile without `allowPromptedStructuredOutput`. The profile always runs OpenCode in prompted mode, so the flag is required even for text-only use. |
| `Codex structured-output schema is incompatible at <pointer>: <reason>` | The selected tool's schema breaks a [Codex schema rule](#codex-runtime). |
| `Harness executable is unavailable` | The CLI is not on `PATH`. Install it or pass `executable`. |
| `Harness output exceeded the configured limit` | stdout and stderr together passed `maxOutputBytes` (default 8 MiB). |
| `<Harness> authentication failed` | The CLI reported an authentication failure. Log in to the harness itself; Relay does not manage harness credentials. |
| `<Harness> rate limited: <reason>` | The CLI hit a rate or usage limit. The error is retryable; the reason may include the reset time. |
| `No Anthropic-compatible API key supplied` | The Anthropic runtime had no `apiKey`, no `client`, and no `ANTHROPIC_API_KEY`. |
| `No replay record matches this invocation` | `ReplayModelRuntime` received a request whose digest differs from every record. Any change to the request, including `metadata`, changes the digest. |
| `Fake runtime has no queued result` | `FakeModelRuntime` was invoked more times than it had results. |
| `runtime profile must use PROFILE:MODEL` | The profile string has no colon, or nothing before or after it. |
| `anthropic runtime requires an API key` | `createModelRuntimeProfile()` was given the `anthropic` profile without `apiKey`. |
