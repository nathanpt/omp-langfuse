# Changelog

All notable changes to **omp-langfuse** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-07-02

### Added
- **GitHub Actions CI.** Three-job workflow (`.github/workflows/ci.yml`) runs on
  PRs, master pushes, and version tags: typecheck + 44 unit tests, esbuild bundle
  with a self-contained check (fails CI if the bundle retains any non-builtin
  import), and on tags attaches the built `dist/index.js` to the GitHub Release.
  The committed bundle remains as the install-workable fallback for Git installs.

## [0.3.0] - 2026-07-02

### Added
- **Installable as an OMP plugin.** `omp install github:nathanpt/omp-langfuse#v0.3.0` now works.
The pre-built bundle (`dist/index.js`) is committed so a Git-source install loads immediately
with no toolchain on the user's machine. README install instructions updated.

### Changed
- Distribution model clarified: per the omp docs, the marketplace/install surface does not
  currently support npm sources, so omp-langfuse is distributed via Git (not npm). The package was
  already shaped correctly as a plugin (`omp.extensions` manifest + factory module) — no trace or
  handler logic changed. The `dist/` bundle is no longer gitignored.

## [0.2.0] - 2026-07-02

### Fixed
- **Latent off-by-1,000,000× bug in the registry-rate fallback.** `ctx.model.cost` comes from the
  OMP model catalog (`@oh-my-pi/pi-catalog`), whose `Model.cost` type is documented as already
  `$/Mtok` — but the resolver was multiplying it by 1,000,000. All **1,968 paid models** in the
  catalog now resolve to their accurate price at runtime via the registry path, with perfect
  id-matching and no table bloat. The bug had been masked because the bundled table caught common
  models and subscription models are zeroed in the catalog.

### Changed
- **Real Zhipu GLM-5.x API rates** (`1.4 / 4.4 / 0.26` per Mtok) replace the GLM-4.6 family estimate
  for `glm-5`, `glm-5.1`, `glm-5.2`. GLM-5.x is zeroed in the catalog (subscription billing), so
  these rates were researched from Z.ai / bigmodel.cn listings and corroborated by the catalog's own
  coreweave GLM-5.1 entry. GLM-4.6 keeps its distinct rate (`0.43 / 1.74 / 0.08`).
  - *Note:* this **raises glm-5.2 cost figures ~3×** — the previous estimate was understating.
- The bundled price table now covers only subscription/zeroed models needing externally-sourced
  rates; paid models rely on the catalog at runtime.

### Tests
- 44/44 unit tests pass (added GLM-4.6-vs-GLM-5 distinction test and a registry-no-conversion
  regression test). Live-verified on `glm-5.2` against a self-hosted Langfuse.

## [0.1.0] - 2026-07-02

First usable release. Ported from
[pi-langfuse](https://github.com/gooyoung/pi-langfuse) v1.5.6 and adapted for OMP's Bun runtime.

### Added
- **One trace per agent run**: a root **agent** observation (user prompt + final assistant response),
  one **generation** observation per provider request, and one **tool** observation per tool call.
- **Self-computed cost**: OMP's host-reported `usage.cost` is zeroed for subscription / free-tier
  models (e.g. GLM-5.2), so cost is always recomputed from token counts × a resolved per-token price
  (`src/pricing.ts`). Bundled price table + `config.pricing` overrides + family-prefix fallback.
- **Privacy presets**: `metadata-only`, `prompts-only`, `conversations`, `full-debug` (default),
  with per-field env overrides (`LANGFUSE_CAPTURE_*`).
- **Redaction**: API keys/tokens, private keys, secret-looking assignments, sensitive object fields,
  and local absolute paths are scrubbed from all payloads; payloads are size-limited.
- **Source / git metadata** on the root observation for slicing traces by project in Langfuse
  (`source_type`, `git_branch`, `git_commit`, `repo_identity`, …), with `.omp-langfuse.metadata.json`
  overrides.
- **Trace-level scores**: `tool_call_count`, `turn_count`, `total_tool_errors`,
  `tool_success_rate`, `session_had_errors`.
- **REST fallback** for self-hosted Langfuse where OTel ingestion alone does not materialize traces.
- **Slash commands**: `/langfuse-setup`, `/langfuse-status`, `/langfuse-test`, `/langfuse-privacy`.
- README, MIT LICENSE.

### Fixed
- **Tool error detection missed non-zero bash exits.** OMP reports a bash command that runs to
  completion but exits non-zero via `event.details.exitCode` while leaving `event.isError = false`.
  The tool handler now also treats a non-zero `exitCode` as an error, so failing commands are flagged
  `level=ERROR` / `isError=true` and counted toward the trace error scores.

### Tests
- 43 unit tests. Live trace audit verified generation usage/cost, tool error flagging, and all
  trace-level scores on a multi-turn, multi-tool run against `glm-5.2`.

[Unreleased]: https://github.com/nathanpt/omp-langfuse/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/nathanpt/omp-langfuse/releases/tag/v0.3.1
[0.3.0]: https://github.com/nathanpt/omp-langfuse/releases/tag/v0.3.0
[0.2.0]: https://github.com/nathanpt/omp-langfuse/releases/tag/v0.2.0
[0.1.0]: https://github.com/nathanpt/omp-langfuse/releases/tag/v0.1.0
