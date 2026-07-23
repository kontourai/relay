# Relay

Relay carries a model invocation across a runtime boundary without deciding
which model should be used or what the response means.

## Language

**Model Runtime**: An implementation of Relay's invocation contract. It may use
a direct SDK, local engine, hosted service, or agent framework.

**Invocation**: One request/result exchange with normalized provider, model,
usage, latency, stop reason, and failure identity.

**Output Token Limit Fidelity**: A runtime capability declaring whether
`maxOutputTokens` is natively enforced, approximated, or unavailable. A request
does not imply enforcement when a profile declares otherwise.

**Runtime Target**: Constructor-only provider configuration supplied by a host,
often after Datum resolution. Credentials are never invocation data.

**Harness Profile**: A thin mapping between a supported non-interactive process
protocol and Relay's invocation contract. It declares only capabilities the
harness can actually provide; the shared process transport owns execution,
abort, output bounds, and sanitized failure behavior.

**Domain Adapter**: A product-owned translation between its semantic operation
and Relay invocation. Traverse extraction is one example.

## Boundaries

- Bearing owns model capability evidence.
- Datum owns provider/model/secret-reference and role resolution.
- Relay owns invocation portability.
- Domain products own prompts, schemas, and interpretation.
- Flow owns process semantics; Flow Agents owns agent workflow enforcement.
