# Relay Agent Guidance

Relay is a semantically inert invocation layer. It normalizes model runtime
requests, results, capabilities, usage, and failures across adapters.

- Never add extraction, review, workflow, trust, or model-selection policy.
- Credentials belong only in adapter construction and must never enter request,
  result, replay, or telemetry records.
- Provider-specific dependencies stay behind optional subpath exports.
- Add conformance coverage for every runtime adapter.
- Install dependencies with `pnpm install`. Run `npm run verify` before pushing.

The pnpm version is pinned in `package.json` (`packageManager`). Dependency
install scripts are blocked by default; the only packages allowed to run one are
listed under `allowBuilds` in `pnpm-workspace.yaml`, pinned by version. Scripts
are still run with `npm run …` — that only invokes `package.json` scripts and
does not depend on which tool installed `node_modules`. Publishing stays on
`npm publish` so provenance and the registry binding are unchanged.

<!-- veritas:governance-block:start -->
This repo uses Veritas for AI governance. Read `.veritas/GOVERNANCE.md` before making changes.
After changes, run `veritas readiness` and address any FAIL lines before finishing.
<!-- veritas:governance-block:end -->
