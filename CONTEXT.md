# Relay

Relay carries a model invocation across a runtime boundary without deciding
which model should be used or what the response means.

## Language

**Model Runtime**: An implementation of Relay's invocation contract. It may use
a direct SDK, local engine, hosted service, or agent framework.

**Invocation**: One request/result exchange with normalized provider, model,
usage, latency, stop reason, and failure identity.

**Runtime Target**: Constructor-only provider configuration supplied by a host,
often after Datum resolution. Credentials are never invocation data.

**Domain Adapter**: A product-owned translation between its semantic operation
and Relay invocation. Traverse extraction is one example.

## Boundaries

- Bearing owns model capability evidence.
- Datum owns provider/model/secret-reference and role resolution.
- Relay owns invocation portability.
- Domain products own prompts, schemas, and interpretation.
- Flow owns process semantics; Flow Agents owns agent workflow enforcement.
