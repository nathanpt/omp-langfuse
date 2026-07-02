# Roadmap — omp-langfuse

Langfuse observability extension for **OMP (oh-my-pi)**. Ported from
[gooyoung/pi-langfuse](https://github.com/gooyoung/pi-langfuse) (v1.5.6), adapted for OMP's Bun
runtime and its divergences from Pi. Full design and the 11 breaking-change fixes live in
[`.docs/DESIGN.md`](./.docs/DESIGN.md).

> Legend: ✅ done · 🟡 partial / deferred · ⬜ not started

---

## ✅ Phase 0 — Scaffold & validate

Confirm the OMP extension/event surface before building.

- ✅ Diffed OMP's published types (`@oh-my-pi/pi-coding-agent@16.3.0`) against Pi's
  (`@earendil-works/pi-coding-agent@0.80.2`) — every verbose-data event survived the fork;
  `after_provider_response` is now richer (`extends ProviderResponseMetadata`).
- ✅ All validation gates resolved statically; live probe (`omp -e`) confirmed the full event chain
  with real payloads.
- ✅ Found `ExtensionAPI` is not exported from the package root — must use the deep subpath import.

## ✅ Phase 1 — Mechanical port + cost module + Bun bundling

Port pi-langfuse to OMP, self-compute cost, and make it runnable on Bun.

- ✅ Copied `src/**` + `test/**`; dropped the obsolete type shim (OMP ships first-class types).
- ✅ Applied all 11 Pi→OMP breaking changes (see DESIGN.md §10), most critically:
  - **Bundling (#11):** OMP's Bun runtime cannot resolve the Langfuse/OTel dependency graph from
    `node_modules` at runtime, so the extension is esbuild-bundled into `dist/index.js`. Build-time
    resolution replaces Bun's broken runtime resolution.
  - **Cost (#7):** host `usage.cost` is zeroed for subscription/free-tier models, so cost is now
    self-computed from token counts × a bundled price table (`src/pricing.ts`).
  - **Model identity (#1):** `model_select` removed → read model + per-token rate from `ctx.model`.
- ✅ `tsc --noEmit` clean against OMP types; **43/43 unit tests pass**.

## ✅ Phase 2 — Behavior port + tests

(Folded into Phase 1 — unit tests ported and passing; handler wiring validated live.)

## ✅ Phase 3 — Integration validation

- ✅ **Core milestone hit:** `omp -e ./dist/index.js -p "use bash to run: echo hi"` against a real
  self-hosted Langfuse produced a trace **with a populated cost figure**. The full pipeline works:
  OMP events → trace tree → generations/tools → self-computed cost → Langfuse.

---

## 🟡 Phase 4 — Polish & publish

Partially complete. v0.1.0 release-ready (package + docs + verified audit); `npm publish` /
marketplace entry deferred to a follow-up (open Q3 — name/scope ownership).

- ✅ **README** — OMP install/usage (`omp` CLI, `~/.omp/agent/omp-langfuse/` config dir, run via
  the bundle), configuration (incl. `pricing` overrides), privacy presets, source/git metadata,
  trace model, troubleshooting. Resolved open Q4 (`omp-agent` trace name) and Q5
  (`.omp-langfuse.metadata.json`) in prose.
- ✅ **Live trace audit** — see [`.docs/AUDIT-v0.1.0.md`](./.docs/AUDIT-v0.1.0.md). Verified
  generation usage/cost, tool `isError`/`level=ERROR` (incl. non-zero bash exits — bug found & fixed),
  and all trace-level scores on a multi-turn, multi-tool run against `glm-5.2`.
- ✅ **Package metadata + version bump** — `version: "0.1.0"`, description corrected.
- ⬜ **Pricing rates refinement** — pin real per-Mtok rates for models you care about (esp.
  `glm-5.2`, currently using the GLM family estimate `0.43 / 1.74 / 0.08`) via `config.pricing` or
  updates to the bundled table in `src/pricing.ts`.
- ⬜ **Optional Langfuse CLI skill** — decide whether to ship the `.agents/skills/langfuse` bundle
  (moved under OMP's `skills/` convention per the authoring doc).
- ⬜ **Marketplace catalog entry** + **npm publish** as `omp-langfuse` (confirm name/scope ownership;
  see open question 3 below).

---

## Open questions (from DESIGN.md §12)

1. Marketplace discovery: is an `omp-package` keyword required, or is the `omp.extensions` manifest
   + directory convention sufficient? *(Probably sufficient — package loads via `omp -e` with no
   keyword; needs final confirmation for marketplace publishing.)*
2. Keep the bundled Langfuse CLI skill, and under which directory convention?
3. npm publish name: `omp-langfuse` (assumed) vs an `@oh-my-pi/` scope — confirm ownership.
4. Trace name `omp-agent` vs `pi-agent` (continuity with existing Langfuse projects)? Draft chose
   `omp-agent`; trivially reversible.
5. Source-metadata override file name `.omp-langfuse.metadata.json` (chosen) vs pi-langfuse's
   `.pi-langfuse.metadata.json`.

---

## Dev workflow (reference)

```bash
npm run typecheck   # tsc --noEmit against OMP types (source)
npm test            # 43 unit tests (source)
npm run build       # esbuild bundle -> dist/index.js (what OMP loads)
omp -e ./dist/index.js -p "..."   # run against a live OMP
```

Edit `index.ts` / `src/**` → `npm run build` → run against `./dist/index.js`.
