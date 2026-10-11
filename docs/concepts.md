# Concepts

Relay carries one model invocation across a runtime boundary. It normalizes the
request, the result, the declared capabilities, the usage receipt, and the
failure, so a product can write a workload once and run it on a direct SDK, an
agent framework, or a local harness CLI. It does not choose a model, retry, or
interpret the response.

This page explains the building blocks and how they fit together. The exact
signatures are in the [Reference](reference.md); the vocabulary is defined in
[CONTEXT.md](../CONTEXT.md).

## Where Relay fits

Relay is one layer in the Kontour stack:

```text
Bearing -> Datum -> Relay -> Traverse / other domain consumers
```

- **Bearing** owns model capability evidence.
- **Datum** owns provider, model, secret-reference, and role resolution. A
  host often resolves a runtime target with Datum and passes it to a Relay
  constructor.
- **Relay** owns invocation portability.
- **Dispatch** composes several runtimes when an application needs selection,
  fallback, or budgets. Relay's `runtime-profile` entrypoint builds exactly one
  runtime and leaves those policies to the host or Dispatch.
- **Domain products** such as Traverse own their prompts, schemas, and the
  meaning of a response. The translation between a product's semantic
  operation and a Relay invocation is a domain adapter that the product owns.
- **Flow** owns process semantics, and **Flow Agents** owns agent workflow
  enforcement.

Relay never adds extraction, review, workflow, trust, or model-selection
policy.

## Model runtime

A model runtime is anything that implements the `ModelRuntime` interface:

- `id`: a string naming the runtime instance, such as `claude-code:sonnet` or
  `anthropic-compatible:claude-sonnet-4-6`.
- `capabilities()`: what the runtime can honestly provide (see
  [Capabilities and fidelity](#capabilities-and-fidelity)).
- `invoke(request, options?)`: one request/result exchange. `options.signal`
  is an `AbortSignal`.
- `invokeBatch(requests, options?)`: optional, and present only on runtimes
  that declare a physical batch (see [Physical batching](#physical-batching)).

Relay ships these runtimes:

| Runtime | Entrypoint | Backed by |
| --- | --- | --- |
| Anthropic-compatible | `@kontourai/relay/anthropic` | The Messages API through `@anthropic-ai/sdk` or an injected client |
| AI SDK | `@kontourai/relay/ai-sdk` | Any Vercel AI SDK v3 `LanguageModelV3` |
| Claude Code | `@kontourai/relay/claude-code` | The `claude` CLI in non-interactive JSON mode |
| Codex | `@kontourai/relay/codex` | `codex exec --json` |
| OpenCode | `@kontourai/relay/opencode` | `opencode run --format json` |
| Generic process | `@kontourai/relay/process` | Any non-interactive CLI, through a codec you write |
| Fake, recording, replay | `@kontourai/relay` | Prepared results, a wrapped runtime, or saved records |

Products should depend on `ModelRuntime`, not on a specific runtime. That keeps
one workload portable between a locally authenticated harness and a hosted API
that the host selects later.

## Invocation request and result

A `ModelInvocationRequest` holds:

- `messages`: an ordered list with role `system`, `user`, `assistant`, or
  `tool`. Content is either a string or a list of parts: `text`, `tool-call`,
  or `tool-result`.
- `tools` and `toolChoice`: the structured tools offered and how one is
  selected (see [Structured tools](#structured-tools)).
- `maxOutputTokens`: the requested output ceiling. Whether it is enforced
  depends on the runtime.
- `metadata`: secret-free string pairs for the caller's own correlation.
  Adapters do not interpret it.

A `ModelInvocationResult` holds:

- `provider` and `model`, plus `modelSource` (see [Model source](#model-source)).
- `outputText` and `toolCalls`.
- `usage`: optional `inputTokens`, `outputTokens`, `totalTokens`,
  `cacheReadTokens`, `cacheWriteTokens`, and `costUsd`. Relay preserves
  provider-reported values and never estimates a missing cost.
- `latencyMs`, an optional `stopReason`, and optional `warnings`.

Credentials are constructor data. They never appear in a request, a result, a
replay record, or a conformance report.

## Model source

`result.model` means different things depending on `result.modelSource`:

- `"provider-reported"`: the provider returned this model identity for this
  invocation. It is the served model.
- `"configured"`: the runtime echoed the model it was configured with, because
  it has no report of the served model. This may be an alias that the provider
  resolved to something else.

Which one each runtime reports:

- The Anthropic-compatible runtime reports the response's `model`, and the
  configured model when the response carries none.
- The AI SDK runtime reports `response.modelId` when the provider model
  supplies one, and the configured `modelId` otherwise.
- The Claude Code runtime reports the served model when the CLI's `modelUsage`
  names exactly one model. With zero or several, it reports the configured
  model, because any single choice would be a guess.
- The Codex and OpenCode runtimes always report `"configured"`.

`modelSource` is optional in the TypeScript type so third-party runtimes keep
compiling, but every bundled runtime sets it and `checkRuntimeConformance()`
fails a runtime that does not.

## Capabilities and fidelity

`capabilities()` returns a `ModelRuntimeCapabilities` declaration. A runtime
must report what it actually provides rather than silently approximating it.

- `structuredTools`, `streaming`, `abort`, `usage`: booleans.
- `structuredToolsFidelity`: how structured tool output is produced.
  `"native"` means the provider or CLI enforces the schema; `"prompted"` means
  the schema is only placed in the prompt; `"unavailable"` means there is no
  structured-output path.
- `outputTokenLimitFidelity`: whether `maxOutputTokens` is `"native"` (sent and
  enforced), `"approximated"` (best effort), or `"unavailable"` (no
  per-invocation hard limit).
- `physicalBatch` and `maxBatchSize`: see [Physical batching](#physical-batching).

The fidelity fields are optional so older custom runtimes stay
source-compatible. All built-in runtimes declare them. Hosts can apply one
routing policy over these declarations without branching the workload by
runtime.

| Runtime | `structuredToolsFidelity` | `outputTokenLimitFidelity` |
| --- | --- | --- |
| Anthropic-compatible | `native` | `native` |
| AI SDK | `native` | `native` |
| Claude Code | `native` | `unavailable` |
| Codex | `native` | `unavailable` |
| OpenCode, default | `unavailable` | `unavailable` |
| OpenCode, `structuredOutput: "prompted"` | `prompted` | `unavailable` |

When the Claude Code CLI reports more output tokens than the request allowed,
the result carries a warning that starts with `OUTPUT_TOKEN_LIMIT_NOT_ENFORCED`.

## Structured tools

A request may offer `tools`, each with a `name`, an optional `description`, and
an `inputSchema` (a JSON Schema object). `toolChoice` is one of
`{ type: "auto" }`, `{ type: "required" }`, or `{ type: "tool", name }`. A
selected tool's output comes back in `result.toolCalls` as `{ id, name, input }`.

The hosted runtimes pass tools and tool choice through to the provider. The
harness CLIs take a schema as an output constraint, not as a tool definition,
so the harness runtimes are narrower:

- A request with no tools is a plain text request.
- A request with tools must select exactly one: `{ type: "tool", name }` naming
  a declared tool, or `{ type: "required" }` with exactly one tool declared.
  Automatic choice, and required choice among several tools, are refused with
  `INVALID_REQUEST`, because the CLI cannot guarantee those semantics.
- The selected tool's `description`, and the `description` of each schema
  field, are added to the prompt so instructions written there reach the
  model. Field descriptions are collected from the schema root, `properties`,
  a single-schema `items`, `anyOf`/`oneOf`/`allOf` branches, and
  `$defs`/`definitions`. Descriptions under other keywords are not added to
  the prompt, but the CLI still receives them inside the schema.

The same structured workload therefore yields the same tool name and input on
every runtime that supports it, while transport identity, usage, latency, and
warnings may differ. That is Relay's portability guarantee.

## Failures and retryability

The built-in runtimes report invocation failures as a `ModelInvocationError`
carrying a `code` and a `retryable` flag. One exception: a local filesystem
error is not wrapped when the Codex runtime creates its temporary directory or
writes its schema file, or when the OpenCode runtime, with no `cwd` set,
creates its temporary directory.

| Code | Meaning |
| --- | --- |
| `ABORTED` | The caller's signal aborted the invocation. |
| `AUTHENTICATION_FAILED` | The provider or CLI refused the credentials, or none were supplied. |
| `INVALID_REQUEST` | The request cannot be expressed on this runtime, or the provider rejected it. |
| `PROVIDER_UNAVAILABLE` | A transient provider, network, or executable-availability failure. |
| `RATE_LIMITED` | A rate limit or usage limit was hit. |
| `RUNTIME_FAILURE` | Anything else, including malformed output. Usually not retryable; OpenCode's unparseable prompted JSON is the retryable exception. |

`retryable` is the signal a router uses to decide whether it may try again or
move to its next candidate. Relay does not retry on its own.

The API runtimes (Anthropic-compatible and AI SDK) classify a failure by its
HTTP status, looking through up to three levels of `cause`:

- 401 or 403: `AUTHENTICATION_FAILED`, not retryable.
- 429: `RATE_LIMITED`, retryable.
- 408, 409, and 5xx other than 501: `PROVIDER_UNAVAILABLE`, retryable.
- 400, 404, or 422: `INVALID_REQUEST`, not retryable.

A failure with no status is `PROVIDER_UNAVAILABLE` and retryable when it is a
transient socket error (such as `ECONNRESET` or `ETIMEDOUT`), carries the AI
SDK's `isRetryable: true`, is an `AbortSignal.timeout()` timeout, or is an
Anthropic SDK connection error. Anything unrecognized is a non-retryable
`RUNTIME_FAILURE`.

The harness runtimes weigh their evidence in this order. Steps 1 to 4 apply
both to a nonzero exit and to a failed run that exits zero; steps 5 and 6 apply
to a nonzero exit.

1. The CLI's structured error report with status 401 or 403 (where the CLI
   reports one): `AUTHENTICATION_FAILED`.
2. The CLI's structured error report naming a limit, or carrying status 429:
   `RATE_LIMITED`, retryable.
3. stderr that looks like an authentication problem: `AUTHENTICATION_FAILED`.
4. stderr that mentions a limit: `RATE_LIMITED`, retryable.
5. stderr that mentions `overloaded`, `unavailable`, or `temporarily`:
   `PROVIDER_UNAVAILABLE`, retryable.
6. Otherwise `RUNTIME_FAILURE`, naming the exit code.

A rate-limit message carries a short reason such as `Claude Code rate limited:
weekly limit reached; resets Oct 4`. The reason is assembled from fixed phrases
and a date, time, or duration matched by a strict pattern, so the CLI's own
output is never copied into it. Usage, session, credit, and quota wording
counts only in the forms that say the limit was hit, so a context-window or
turn limit is not reported as a rate limit.

## Process transport and harness profiles

`@kontourai/relay/process` is the shared transport for non-interactive CLIs.
`createProcessRuntime()` spawns the executable, writes the prepared stdin,
captures stdout and stderr, and owns abort, output bounds, and failure
sanitizing. A harness profile is a thin codec on top of it:

- `prepare(request)` turns the request into command-line `args` and `stdin`.
- `parse(output, request)` turns the captured output into a result.
- `classifyFailure(output, request)`, optional, turns a nonzero exit into a
  typed failure.

The transport never interprets prompts, chooses a model, discovers
credentials, or copies the constructor `environment` into results and errors.
The Claude Code, Codex, and OpenCode runtimes are profiles built this way, and
each declares only the capabilities its CLI can actually provide.

Authentication stays with the installed harness. Relay does not inspect, copy,
or persist the harness's credential configuration.

## Runtime profiles

`@kontourai/relay/runtime-profile` lets applications share one `PROFILE:MODEL`
string, such as `codex:gpt-5`, instead of copying adapter `switch` statements.
The profiles are `claude-code`, `codex`, `opencode`, and `anthropic`.

`createModelRuntimeProfile()` constructs exactly one runtime. It does not
select providers, define fallback, or own budgets. Two choices stay explicit:
the `opencode` profile always runs in prompted structured-output mode and
refuses to construct without `allowPromptedStructuredOutput`, and the
`anthropic` profile requires an `apiKey` option. The profile resolver never
reads a credential itself.

## Physical batching

A runtime may expose `invokeBatch()` only when one call maps to one physical
provider or runtime operation. Concurrent `invoke()` calls do not qualify. A
batch returns one positional outcome per request: `{ status: "fulfilled",
value }` or `{ status: "rejected", reason }`, where `reason` is a content-free
`{ code, message, retryable }`. One rejected item does not erase its
successful siblings; a rejected promise means the whole operation failed.

The built-in hosted and harness runtimes report physical batching as
unavailable. `FakeModelRuntime` implements it, up to 100 items, so consumers
can test batch handling.

## Record and replay

`RecordingModelRuntime` wraps any runtime and appends an
`InvocationReplayRecord` for each successful invocation: `schemaVersion: 1`, a
`requestDigest`, and copies of the request and result. `ReplayModelRuntime`
takes those records and returns the recorded result for a request with the
same digest. A request with no matching record fails with `INVALID_REQUEST`.

The digest is `invocationDigest(request)`: `sha256:` followed by the SHA-256 of
the request's canonical JSON, in which object keys are sorted. Two requests
that differ only in key order get the same digest.

Recording captures request content by design. Hosts apply their own
content-handling policy to stored records.

## Conformance

Relay exports two report-producing checks. Neither throws on a failed check.

- `checkRuntimeConformance(runtime)` validates the capability declaration
  (including that fidelity values are consistent with `structuredTools` and
  that `invokeBatch` exists exactly when `physicalBatch` is declared), then
  makes one invocation and checks the result's identity, `modelSource`, and
  shape.
- `checkPhysicalBatchConformance(runtime, requests, options?)` issues one
  caller-supplied probe batch and checks the declaration, request count,
  positional correspondence, and typed outcomes. With
  `requireMixedOutcomes: true`, it also requires at least one fulfilled and
  one rejected item. Its report holds counts and check results only, never
  request, response, or provider-diagnostic content.
