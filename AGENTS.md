# Relay Agent Guidance

Relay is a semantically inert invocation layer. It normalizes model runtime
requests, results, capabilities, usage, and failures across adapters.

- Never add extraction, review, workflow, trust, or model-selection policy.
- Credentials belong only in adapter construction and must never enter request,
  result, replay, or telemetry records.
- Provider-specific dependencies stay behind optional subpath exports.
- Add conformance coverage for every runtime adapter.
- Install dependencies with `pnpm install`. Run `npm run verify` before pushing.
- Docs publish with Corpus: `corpus.json` lists the published docs and MCP
  topics, and `npm run docs:check` is the gate. When you change code a
  document `covers`, update that document.

The pnpm version is pinned in `package.json` (`packageManager`). Dependency
install scripts are blocked by default; the only packages allowed to run one are
listed under `allowBuilds` in `pnpm-workspace.yaml`, pinned by version. Scripts
are still run with `npm run …` — that only invokes `package.json` scripts and
does not depend on which tool installed `node_modules`. Publishing stays on
`npm publish` so provenance and the registry binding are unchanged.

## Documentation freshness

The Corpus gate is strict for the source paths declared in `corpus.json`.
Review the selected canonical guides when those files change. Update inaccurate
claims in the same PR. When the prose remains accurate, record a new local
input/output byte review with a concrete explanation and limits in
`corpus-content.json`; do not add filler text or refresh hashes without review.
The shared [Corpus review contract](https://github.com/kontourai/corpus/blob/b127e35a818b532369843731b3c64792baade83e/docs/related-content.md#review-an-unchanged-covering-document)
owns that format. CI uses the reviewed shared pin; for local review checks use
that same Corpus revision with `check --base origin/main`.

<!-- veritas:governance-block:start -->
This repo uses Veritas for AI governance. Read `.veritas/GOVERNANCE.md` before making changes.
After changes, run `npx --no @kontourai/veritas readiness` and address any FAIL lines before finishing.
<!-- veritas:governance-block:end -->
