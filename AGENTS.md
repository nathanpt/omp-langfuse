# AGENTS.md

Operating manual for AI coding agents (and humans) working on omp-langfuse. Read this before
making changes or cutting a release.

## Current state

- **Version:** `0.3.2` (see `package.json` and `git describe --tags`)
- **Repo:** `git@github.com:nathanpt/omp-langfuse.git`, default branch `master`
- **Distribution:** Git-only OMP plugin (`omp install github:nathanpt/omp-langfuse#vX.Y.Z`). npm is
  not supported by omp's install surface.
- **CI:** `.github/workflows/ci.yml` — typecheck + tests + build on PRs/master; on `v*` tags it
  builds `dist/index.js`, extracts the matching `docs/CHANGELOG.md` section, and creates the GitHub
  Release.
- **Shipped so far:** v0.1.0 (first usable), v0.2.0 (accurate cost via catalog + real GLM-5 rates),
  v0.3.0 (installable as a plugin), v0.3.1/v0.3.2 (CI).
- **Open (optional):** marketplace catalog repo; optional Langfuse CLI skill.

> Update this block when you tag a release.

## Quick start for a fresh session

Get to a working live probe in under two minutes.

1. **Install deps + build the bundle:**
   ```bash
   npm install && npm run build
   ```
2. **Confirm quality gates:** `npm run typecheck && npm test` (must stay clean).
3. **Live credentials live outside the repo** at `~/.omp/agent/omp-langfuse/config.json` (0600), or
   as env vars `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL`. If that file is
   absent, the extension's first-run UI prompt will create it; in headless mode set the env vars.
   Do **not** commit credentials — the repo is public.
4. **Run a one-shot trace probe** (reads creds from the config file above):
   ```bash
   omp -e ./dist/index.js -p "use bash to run: echo hi"
   ```
   You should see `📊 Langfuse: Tracing enabled → <host>` at startup.
5. **Default test model** is whatever OMP is configured to use (this machine: `zai/glm-5.2`).
   glm-5.2 is zeroed in the catalog (subscription); cost comes from the bundled GLM-5 rate
   (`1.4 / 4.4 / 0.26` per Mtok) in `src/pricing.ts`.

For a full trace audit (multi-turn, multi-tool, with an intentional failure), see **Verification**
below.

## What this is

omp-langfuse is a Langfuse observability **plugin** for [OMP](https://omp.sh) (oh-my-pi). It sends
one trace per agent run — root agent observation, one generation per provider request, one tool
observation per tool call — with **self-computed cost** (OMP zeroes host `usage.cost` for
subscription/free-tier models, so we never trust it).

Ported from [pi-langfuse](https://github.com/gooyoung/pi-langfuse) v1.5.6 and adapted for OMP's Bun
runtime. The design notes and audits live in `.docs/` (gitignored, local-only); the public docs are
`docs/CHANGELOG.md`.

## Critical constraints (do not violate)

1. **Don't change how traces are obtained.** The lifecycle subscriptions in `index.ts`
   (`pi.on("before_provider_request", …)`, etc.) and the handler tree under `src/handlers/` are the
   proven trace path modeled on pi-langfuse. Mimic it; don't reinvent it. Any change here needs a
   live verification run against a real Langfuse (see Verification below).

2. **`dist/index.js` must be committed.** OMP's install path (`omp install github:…#tag`) clones the
   repo with no build step, so the bundle has to ship in-tree. It is **not** gitignored. If you
   change `index.ts` or anything under `src/`, rebuild and commit `dist/index.js` in the same change.

3. **Distribution is Git-only.** Per the omp docs, the marketplace/install surface does not currently
   support npm sources. Do not add npm-publish tooling; it's a dead path. Users install via
   `omp install github:nathanpt/omp-langfuse#<tag>`.

4. **Cost is self-computed from token usage × a resolved price** (`src/pricing.ts`), never from host
   `usage.cost`. Price resolution precedence: config override → bundled exact → bundled family prefix
   → catalog rate (`ctx.model.cost`, already $/Mtok — **do not unit-convert it**, there was a
   historical off-by-1e6 bug here).

## Dev workflow

```bash
npm run typecheck   # tsc --noEmit against OMP types (must stay clean)
npm test            # unit tests (tsx --test)
npm run build       # esbuild bundle -> dist/index.js  (commit this on any code change)
omp -e ./dist/index.js -p "..."   # one-shot run against a live OMP
```

All three of typecheck / test / build must pass before a change is merged. CI re-runs them, but run
locally first — CI does not run a live Langfuse probe.

## Verification (for changes touching traces/pricing/handlers)

Unit tests are not enough for trace-path changes. Verify against a real Langfuse before merging:

1. Build: `npm run build`
2. Run a multi-turn, multi-tool prompt that includes an intentional tool failure (non-zero bash exit):
   `omp -e ./dist/index.js -p "…"`
3. Fetch the latest trace via the Langfuse API and confirm: generation usage + `costDetails`,
   tool `level=ERROR`/`isError=true` on the failing call, and all trace-level scores
   (`tool_call_count`, `turn_count`, `total_tool_errors`, `tool_success_rate`, `session_had_errors`).

See `.docs/AUDIT-v0.1.0.md` (local) for the canonical example of this audit.

## Project layout

```
index.ts                  extension entry: lifecycle subscriptions + command registration
src/
  config.ts               credential loading/saving, UI setup flow
  pricing.ts              per-token price resolution + cost computation
  handlers/{agent,turn,generation,tool}.ts   observation builders (the trace path)
  langfuse.ts             @langfuse/tracing + OTel runtime, REST fallback, score sending
  state.ts, capture-policy.ts, redaction.ts, source-metadata.ts, utils.ts, types.ts, constants.ts
  commands.ts             /langfuse-* command handlers
test/                     unit tests (npm test)
docs/CHANGELOG.md         public changelog (single source of truth for release notes)
dist/index.js             COMMITTED bundle (what omp loads from a git-source install)
.github/workflows/ci.yml  CI: typecheck + test + build, release on tag
.docs/                    LOCAL-ONLY (gitignored): ROADMAP.md, DESIGN.md, audits
```

## Release workflow

This project uses **curated, intentional releases** shaped by the roadmap-story-planning skill —
each release is one coherent story, not auto-cut per commit. Do **not** introduce auto-versioning
tools (semantic-release, standard-version, Changesets); they fight the intentional-release model.

The CHANGELOG is the single source of truth for release notes: CI extracts the matching
`## [X.Y.Z]` section and promotes it to the GitHub Release body. A missing/empty section **fails
CI**.

### To cut a release (all steps are agent-executable)

Determine the next version by the story's nature: patch (fix/CI/internal), minor (new behavior,
non-breaking), or major (breaking change).

1. **Bump version** in `package.json`: `"version": "X.Y.Z"`.
2. **Add a CHANGELOG entry** in `docs/CHANGELOG.md`:
   - New `## [X.Y.Z] - YYYY-MM-DD` section under `## [Unreleased]`, grouped by `### Added` /
     `### Changed` / `### Fixed` / `### Tests`. Write curated paragraphs, not commit-log dumps.
   - Update the compare link: change `[Unreleased]: …compare/vOLD...HEAD` to
     `…compare/vNEW...HEAD`, and add `[X.Y.Z]: https://github.com/nathanpt/omp-langfuse/releases/tag/vX.Y.Z`.
3. **Rebuild the bundle**: `npm run build`, then `git add dist/index.js` (it must match the source).
4. **Verify locally**: `npm run typecheck && npm test` (and a live Langfuse run if trace/pricing
   code changed).
5. **Commit** all of the above (`package.json`, `docs/CHANGELOG.md`, `dist/index.js`, any source).
6. **Tag**: `git tag -a vX.Y.Z -m "vX.Y.Z — <one-line headline>"`.
7. **Push**: `git push origin master && git push origin vX.Y.Z`.
8. **CI does the rest**: typecheck + test + build → creates the GitHub Release with your hand-written
   notes → attaches `dist/index.js`. Watch with `gh run watch` on the tag run.

Do **not** create the GitHub Release manually — CI owns release creation (it will fail to attach the
bundle if a release already exists without the asset, and the notes would diverge from the CHANGELOG).

### Release-worthiness check

Before tagging, confirm the story is release-worthy: one headline, one user-facing value prop, all
slices done and verified, out-of-scope items genuinely excluded. A coding day is defensible when the
branch tells a single story — not when it accumulates unrelated motion.

## Commit & branch conventions

- Feature/release work happens on a named branch (`release/vX.Y.Z`, `pricing/accurate-cost`,
  `ci/build-workflow`), then merged to `master` with `--no-ff`.
- Commit messages: imperative mood, body explains *why*. No Conventional Commits prefix required —
  the curated CHANGELOG carries the intent, not the commit subjects.

## Open roadmap items (optional, not urgent)

- **Marketplace catalog repo** (e.g. `nathanpt/omp-plugins`) for `name@catalog` install discovery.
  Decoupled from this repo; only worth it when there's a second plugin to list.
- **Optional Langfuse CLI skill** — decide whether to ship under OMP's `skills/` convention.
