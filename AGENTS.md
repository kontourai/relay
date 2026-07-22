# Relay Agent Guidance

Relay is a semantically inert invocation layer. It normalizes model runtime
requests, results, capabilities, usage, and failures across adapters.

- Never add extraction, review, workflow, trust, or model-selection policy.
- Credentials belong only in adapter construction and must never enter request,
  result, replay, or telemetry records.
- Provider-specific dependencies stay behind optional subpath exports.
- Add conformance coverage for every runtime adapter.
- Run `npm run verify` before pushing.
