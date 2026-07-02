# DESIGN — omp-langfuse

Langfuse observability extension for **OMP (oh-my-pi)**. This document defines what we are
building, how it maps onto OMP's extension model, how it differs from its Pi-based predecessor
(`pi-langfuse`), and the open risks to resolve before/while implementing.

> Status: v0.1.0 released. Pipeline verified end-to-end against a real self-hosted Langfuse
> (see [`.docs/AUDIT-v0.1.0.md`](./AUDIT-v0.1.0.md)). npm publish / marketplace entry is a planned
> follow-up. Results in §10. The runtime event trace still needs a configured model to fire (see §10, last note).

---

## 1. Goals & Non-Goals

### Goals
- Ship one Langfuse trace per OMP agent run (one per user prompt), grouped by OMP session.
- Capture a root **agent** observation, one **generation** observation per provider request, and one
  **tool** observation per tool call — the same three-tier trace model `pi-langfuse` uses.
- Capture usage/cost when the provider exposes it; mark tool failures; attach trace-level scores
  (tool counts, tool success rate, error flags, turn count).
- Keep privacy controls (presets + fine-grained flags), secret/path redaction, and a REST fallback
  for self-hosted Langfuse where OTel ingestion alone does not materialize traces.
- Feel native to OMP: `omp` CLI, `~/.omp/agent/` config dir, `omp.extensions` manifest key,
  `@oh-my-pi/pi-coding-agent` peer dependency.

### Non-Goals (for v1)
- No new Langfuse SDK features beyond what `pi-langfuse` already uses (`@langfuse/tracing` +
  `@langfuse/otel` + `@langfuse/client`).
- No UI/dashboard inside OMP beyond the existing slash commands.
- No support for non-OMP hosts (we will not keep a dual Pi/OMP codepath; see §4).

---

## 2. Background

### 2.1 OMP vs Pi
OMP (`@oh-my-pi/pi-coding-agent`, `omp.sh`) is a fork of Mario Zechner's Pi
(`@earendil-works/pi-coding-agent`), extended by `can1357`. Because it is a fork, the extension and
hook surfaces are expected to be **largely identical**, but the user has flagged that **cross-fork
extension compatibility is not guaranteed**. We therefore treat the port as a first-class port, not
an assumption, and validate the API surface explicitly (§10).

### 2.2 What pi-langfuse does (our starting point)
Source: https://github.com/gooyoung/pi-langfuse (v1.5.6). It:

- Subscribes to the full Pi lifecycle (`session_start`, `model_select`, `before_agent_start`,
  `agent_start`, `turn_start`, `before_provider_request`, `after_provider_response`,
  `message_update`, `message_end`, `tool_execution_start`, `tool_call`, `tool_result`,
  `tool_execution_end`, `turn_end`, `agent_end`, `session_before_switch`, `session_before_fork`,
  `session_compact`, `session_shutdown`).
- Keeps per-session state in an `AsyncLocalStorage` scope (`src/state.ts`) so overlapping sessions
  do not leak observations into each other.
- Builds the trace tree via `@langfuse/tracing`'s observation API (`startObservation`,
  `update`, `end`, `startObservation(..., { asType })`) and exports spans via an OTel Node SDK with
  a Langfuse exporter.
- Derives the session id from `ctx.sessionManager.getSessionFile()` (basename of the `.jsonl`).
- Persists credentials to `~/.pi/agent/pi-langfuse/config.json` (0700 dir / 0600 file) and falls back
  to `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` env vars.
- Applies privacy presets (`metadata-only`, `prompts-only`, `conversations`, `full-debug`) and
  fine-grained flags, redacts secrets + local absolute paths, and computes source/git metadata.

---

## 3. Scope of the Port

We adopt `pi-langfuse`'s architecture wholesale, then apply the OMP-specific deltas below. We do
**not** keep `pi.extensions` / `@earendil-works/...` compatibility — this is an OMP-only package.

---

## 4. Compatibility Matrix: Pi → OMP

This is the core of the port. Each row is a concrete, mechanical change unless marked **[VALIDATE]**.

| Concern | pi-langfuse (Pi) | omp-langfuse (OMP) | Confidence |
|---|---|---|---|
| Peer dependency package | `@earendil-works/pi-coding-agent` | `@oh-my-pi/pi-coding-agent` | High |
| Type import for `ExtensionAPI` | `@earendil-works/pi-coding-agent` | `@oh-my-pi/pi-coding-agent` | High |
| Type shim module declaration (`types/pi-coding-agent.d.ts`) | `declare module "@earendil-works/pi-coding-agent"` | `declare module "@oh-my-pi/pi-coding-agent"` | High |
| Manifest key in `package.json` | `"pi": { "extensions": ["./index.ts"] }` | `"omp": { "extensions": ["./index.ts"] }` | High (legacy `pi.extensions` still accepted, but use `omp`) |
| Package name | `pi-langfuse` | `omp-langfuse` | High |
| Keyword | `pi-package` | `omp-package` | Low — keyword is for npm/marketplace search only; OMP discovery is by directory + `omp.extensions` manifest, no keyword required (confirmed: package loads via `omp -e`). |
| Config directory | `~/.pi/agent/pi-langfuse/` | `~/.omp/agent/omp-langfuse/` | High |
| Config file | `~/.pi/agent/pi-langfuse/config.json` | `~/.omp/agent/omp-langfuse/config.json` | High |
| CLI for local load | `pi link`, `pi install npm:pi-langfuse` | `omp install ./omp-langfuse` / `omp --extension ./omp-langfuse`; `extensions:` list in `~/.omp/agent/config.yml` | High (per OMP authoring docs) |
| Install command in README | `pi install npm:pi-langfuse` | `omp install npm:omp-langfuse` (once published) **[VALIDATE]** npm publish name | Medium |
| First-run setup prompt text | "Run this extension in Pi UI..." | "...in OMP UI..." | High |
| Trace / observation name prefixes | `pi-agent`, `llm-generation` | `omp-agent`, `llm-generation` (keep generation name) | High |
| Log prefix | `📊 Langfuse:` | keep as-is (cosmetic, recognizable) | High |

### Events & context — RESOLVED (statically validated against OMP types)
`pi-langfuse` depends on these being emitted by the host. **Validation: every event pi-langfuse
uses is present in OMP's `ExtensionAPI`**, and `AfterProviderResponseEvent` is now *richer*. The
full event diff (Pi vs OMP `ExtensionAPI.on(...)` overloads):

- **Present in BOTH (survived the fork)**: `session_start`, `session_shutdown`, `before_agent_start`,
  `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`,
  `message_end`, `before_provider_request`, `after_provider_response`, `tool_execution_start`,
  `tool_execution_update`, `tool_execution_end`, `tool_call`, `tool_result`, `context`, `input`,
  `session_before_switch`, `session_before_compact`, `session_compact`, `session_before_tree`,
  `session_tree`, `resources_discover`, `user_bash`.
- **Removed in OMP (must adapt)**: `model_select` → read model from `ctx.model`;
  `session_before_fork` → renamed `session_before_branch`; `project_trust`, `thinking_level_select`
  (unused by pi-langfuse).
- **New in OMP (bonus verbosity available)**: `session_stop` (carries `session_id`/`session_file`/
  `turn_id` — a cleaner session-id source), `session_switch`, `session_branch`,
  `auto_compaction_start/end`, `goal_updated`, `tool_approval_requested/resolved`, `ttsr_triggered`,
  `todo_reminder`, `credential_disabled`, `user_python`, `auto_retry_start/end`.

**Net: verbosity is not just preserved, it is expandable.** The provider events that feed
generation usage/cost (`before_provider_request`, `after_provider_response`) survived intact,
and `after_provider_response` now `extends ProviderResponseMetadata` (`{ status, headers,
requestId?, metadata? }`) — a strict superset of Pi's `{ status, headers }`, adding a first-class
`requestId` and a provider `metadata` bag. Per-request token/cost still come from the finalized
assistant message in `message_end` (unchanged path).

### Context object (`ctx`) — RESOLVED
`pi-langfuse` reads from `ctx`, all confirmed present on OMP's `ExtensionContext`:
- `ctx.sessionManager.getSessionFile()` → session id ✅ (returns `string | undefined` now).
- `ctx.ui.notify(msg, level)` / `ctx.ui.input(title, placeholder)` ✅ (also `confirm`, `select`).
- `ctx.hasUI: boolean` ✅.
- `ctx.model: Model | undefined` ✅ — the clean `model_select` replacement.
- (`ctx.cwd`, `ctx.modelRegistry` ✅.) Note: OMP **dropped `ctx.mode`** from `ExtensionContext`
  (pi-langfuse never used it).

---

## 5. Architecture (ported from pi-langfuse)

### 5.1 Trace model
```
Trace (name: "omp-agent")
├── sessionId: <omp-session-id>
├── input:    user prompt (+ images / context summary when present)
├── output:   final assistant response
└── Agent observation (name: "omp-agent", type: agent)
    ├── Generation observation (name: "llm-generation", type: generation)
    │   ├── input:  provider request payload / message history
    │   ├── output: finalized assistant message (incl. tool-call payloads)
    │   ├── model, usageDetails, costDetails
    │   └── metadata: provider, requestId, status
    └── Tool observation (name: "<tool-name>", type: tool)
        ├── input:  tool parameters
        ├── output: tool result (shaped + truncated)
        └── metadata: toolCallId, isError, durationMs, inputBytes, outputBytes
```

### 5.2 Event flow (per agent run)
1. `session_start` → load config, reset run state.
2. `model_select` → record `currentModel` / `currentProvider`.
3. `before_agent_start` / `agent_start` → create root **agent** observation + trace.
4. `turn_start` → open a turn span (parents generations + tools).
5. `before_provider_request` → start a **generation**.
6. `after_provider_response` → attach provider metadata + early error status.
7. `message_update` → record TTFT; stash latest assistant output.
8. `message_end` → finalize the active generation.
9. `tool_execution_start` / `tool_call` → start a **tool** observation.
10. `tool_result` / `tool_execution_end` → finalize the matching tool observation.
11. `turn_end` → increment turn count; synthesize fallback generation if none closed; close turn span.
12. `agent_end` → close root observation, mirror trace I/O, send trace-level scores, defer runtime shutdown.
13. `session_shutdown` (or `session_before_switch`/`session_before_fork`) → close dangling
    observations, mark run `completed=false, cancelled=true`, flush telemetry.

### 5.3 Session isolation
Inherited unchanged: an `AsyncLocalStorage<string>` scope wraps every event handler via
`runWithSession(getSessionId(ctx), fn)`, and all mutable state (`currentModel`, `agentState`,
counters, `setupAttemptedThisSession`) is stored per session id in a `Map`. This prevents concurrent
OMP sessions from corrupting each other's active observations.

### 5.4 Langfuse runtime & REST fallback
Same approach as `pi-langfuse`: a lazily-initialized OTel Node SDK with a Langfuse exporter drives
`@langfuse/tracing` observations; a REST fallback (`@langfuse/client`) is used when self-hosted
deployments accept OTel spans but never materialize a trace (a known Langfuse self-host quirk).

---

## 6. Proposed File Layout

Mirror `pi-langfuse`, with the deltas from §4 applied. `package.json` will use `omp.extensions`.

```
omp-langfuse/
├── .docs/
│   └── DESIGN.md                ← this file
├── index.ts                     ← extension factory: registerCommand + pi.on(...) wiring (source)
├── dist/                        ← BUILD OUTPUT (gitignored) — the bundled entry OMP loads
│   └── index.js                 ← esbuild bundle: index.ts + src/ + all deps, self-contained
├── src/
│   ├── handlers/
│   │   ├── agent.ts             ← root agent observation, trace I/O, scores
│   │   ├── generation.ts        ← provider request → generation lifecycle, TTFT
│   │   ├── tool.ts              ← tool observation lifecycle + close-dangling
│   │   └── turn.ts              ← turn span parenting generations/tools
│   ├── capture-policy.ts        ← privacy presets + fine-grained flags
│   ├── commands.ts              ← /langfuse-setup|test|status|privacy handlers
│   ├── config.ts                ← load/save config, interactive setup UI
│   ├── constants.ts             ← paths, host, payload limits  (paths → ~/.omp/...)
│   ├── langfuse.ts              ← runtime init/flush/shutdown, REST fallback
│   ├── observation.ts           ← LangfuseObservation helpers
│   ├── pricing.ts               ← self-sourced per-token price table + cost computation
│   ├── redaction.ts             ← secret + absolute-path redaction
│   ├── source-metadata.ts       ← git identity + safe override whitelist
│   ├── state.ts                 ← AsyncLocalStorage session-scoped state
│   ├── types.ts                 ← shared runtime/observation types
│   └── utils.ts                 ← payload shaping, message extraction
├── test/                        ← focused unit tests (state, config, capture, redaction, pricing, ...)
├── .agents/skills/langfuse/...  ← (optional) Langfuse CLI skill bundle
├── package.json
├── tsconfig.json
└── README.md
```

> No `types/pi-coding-agent.d.ts` shim: OMP ships first-class types (see §10 gate 5).

---

## 7. Configuration & Privacy

### 7.1 Credential resolution (precedence high → low)
1. `~/.omp/agent/omp-langfuse/config.json` (0700 dir / 0600 file) — written by interactive setup.
2. Environment variables: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`,
   `LANGFUSE_BASE_URL` (alias `LANGFUSE_HOST`).

### 7.2 Slash commands (names preserved; provider-neutral)
- `/langfuse-setup` — interactive key entry.
- `/langfuse-test` — auth check + small test trace.
- `/langfuse-status` — masked keys, host, capture source, active-run state, last error.
- `/langfuse-privacy` — view/set privacy preset.

### 7.3 Privacy presets (unchanged semantics)
| Preset | Captures |
|---|---|
| `metadata-only` | Metadata only |
| `prompts-only` | Prompt/provider inputs + metadata |
| `conversations` | Inputs + assistant outputs (no tool I/O, system prompt, cwd) |
| `full-debug` | Everything (default) |

Fine-grained env/config flags (`LANGFUSE_CAPTURE_INPUTS`, `_OUTPUTS`, `_TOOL_IO`,
`_SYSTEM_PROMPT`, `_CWD`) override the preset.

### 7.4 Pricing overrides (cost computation)

Per-model price overrides live under `pricing` in `config.json`. Keys are matched against the
runtime `message.model` id, exact match first. Values are **per-million-tokens USD**. Any omitted
component defaults to `0`.

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "host": "https://cloud.langfuse.com",
  "pricing": {
    "glm-5.2":         { "input": 0.50, "output": 2.00, "cacheRead": 0.10 },
    "gpt-5.2":         { "input": 1.25, "output": 10.00, "cacheRead": 0.125 }
  }
}
```

Keys: `input`, `output`, `cacheRead`, `cacheWrite` (all per Mtok, all optional). An override entry
with an unknown model id is harmless. Resolution precedence and the bundled table are documented in
§8.1.

---

## 8. Data Model — What Gets Tracked

Inherited from `pi-langfuse` (rename only the trace/agent names to `omp-agent`):

**Trace**: `input` (prompt), `output` (final assistant response), `sessionId`, `metadata.model`,
`metadata.provider`, `metadata.cwd` (privacy-gated).

**Agent observation**: type `agent`, name `omp-agent`, input/output mirror, session/model/provider
metadata.

**Generation observation**: type `generation`, name `llm-generation`, request payload → finalized
message, `model`, `usageDetails.{input,output,total}`, `costDetails.{total,input,output}` — **cost is
self-computed** (see §8.1), never trusted from host `usage.cost`, provider metadata.

**Tool observation**: type `tool`, name = tool name, params/result, `metadata.{toolCallId,isError,
durationMs,inputBytes,outputBytes}`, `level=ERROR` on failure.

**Scores**: trace-level `tool_call_count`, `turn_count`, `total_tool_errors`,
`tool_success_rate` (0–1), `session_had_errors` (0/1); observation-level `tool_is_error` (0/1).

### 8.1 Cost computation (self-sourced pricing)

**Problem.** OMP's `message.usage.cost` is host-computed from the model registry's `cost` rates. For
subscription / zero-priced models the registry rates are `0`, so `usage.cost.total === 0` (confirmed
live for `glm-5.2`). Trusting `usage.cost` would leave Langfuse cost columns blank for exactly the
class of models we care about. We therefore **always compute cost ourselves** from the populated
token counts, for every model, regardless of host-reported cost.

**Decision (user-confirmed):** bundle a maintained per-token price table + allow per-model config
override. (Config-only and registry-only were considered; bundled+override chosen for lower setup
friction.)

**Compute formula** (per assistant message, in USD):
```
cost.input     = usage.input     * rate.input
// output tokens
// cacheRead tokens are cheaper (cache-hit rate)
// cacheWrite tokens are more expensive (cache-write premium)
cost.output    = usage.output    * rate.output
cost.cacheRead = usage.cacheRead * rate.cacheRead
cost.cacheWrite= usage.cacheWrite* rate.cacheWrite
cost.total     = sum of the above
```
Rates are stored **per-million-tokens** (matches how providers publish prices) and divided by
`1_000_000` at compute time. Missing token fields are treated as `0`. Cache costs are included by
default (they materially affect real spend).

**Price resolution precedence** (first match wins), resolved per message from `message.model`:
1. **User config override** — exact `modelId` match in `config.pricing` (see §7.4).
2. **Bundled table, exact** `modelId` match.
3. **Bundled table, family prefix** — longest matching family key (e.g. `glm-5.2` → `glm` family →
   GLM-4.6 rate as an *estimate*; `claude-sonnet-4-20250514` → `claude-sonnet-4`).
4. **Registry rate** — `ctx.model.cost` if all four fields are non-zero (rare for our target models).
5. **None** — omit `costDetails` for that message; emit a one-time `📊 Langfuse: no price for
   model "<id>"` warning so the user knows to add an override.

**Bundled starter table** (per Mtok, USD). Prices sourced from provider listings dated 2026-07;
_flagged entries are estimates — verify/override for accuracy._

| Model / family (id match) | input | output | cacheRead | cacheWrite | Source / confidence |
|---|---|---|---|---|---|
| `deepseek-v3`, `deepseek-v3.1`, `deepseek-chat` | 0.27 | 1.10 | 0.07 | — | DeepSeek API (high) |
| `deepseek-r1`, `deepseek-reasoner` | 0.55 | 2.19 | 0.14 | — | DeepSeek API (high) |
| `glm-4.6`, `glm-4-32b`, `glm`* | 0.43 | 1.74 | 0.08 | — | Deep Infra/OpenRouter (high) |
| `glm-5.2`, `glm-5`* | 0.43 | 1.74 | 0.08 | — | _estimate from glm-4.6 family — OVERRIDE recommended_ |
| `claude-sonnet-4`, `claude-3-5-sonnet` | 3 | 15 | 0.30 | 3.75 | Anthropic (high) |
| `claude-haiku-4`, `claude-3-5-haiku` | 1 | 5 | 0.10 | 1.25 | Anthropic (high) |
| `claude-opus-4`, `claude-3-opus` | 15 | 75 | 1.50 | 18.75 | Anthropic (high) |
| `gpt-4.1` | 2 | 8 | 0.50 | — | OpenAI (high) |
| `gpt-4.1-mini` | 0.40 | 1.60 | 0.10 | — | OpenAI (high) |
| `gpt-4.1-nano` | 0.10 | 0.40 | 0.025 | — | OpenAI (high) |
| `gpt-4o` | 2.50 | 10 | 1.25 | — | OpenAI (high) |
| `gpt-4o-mini` | 0.15 | 0.60 | 0.075 | — | OpenAI (high) |
| `o3-mini`, `o4-mini` | 1.10 | 4.40 | 0.55 | — | OpenAI (high) |
| `gpt-5`, `gpt-5.1`, `gpt-5.2`* | — | — | — | — | _unset — pricing uncertain; add override_ |

`*` = family/prefix entry. `—` = provider does not publish this component (treated as 0).

> **Maintenance reality (acknowledged):** model pricing changes faster than this extension ships.
The bundled table is a convenience baseline, not a source of truth. The one-time "no price for
model" warning + trivial config overrides are the intended correction path. `cacheWrite` rates are
only available for Anthropic; other providers' cache-write costs are omitted (not invented).

---

## 9. Security: Redaction & Source Metadata

- All captured payloads pass through `redaction.ts` before upload: API keys, bearer tokens,
  passwords, cookies, private keys, Langfuse keys, GitHub/npm/AWS-style tokens, and **local absolute
  paths** are masked.
- Source metadata attaches safe git identity (`source_type`, `repo_identity=owner/repo`,
  `repo_owner`, `repo_name`, branch, commit, remote host/path) and never uploads raw absolute paths,
  credentialed remotes, tokens, or non-Git folder names.
- Optional repo-local `.omp-langfuse.metadata.json` allows a **whitelist-only** override set
  (`repo_identity`, `repo_owner`, `repo_name`, `source_type`, `service_name`, `project_slug`,
  `environment`, `observability_owner`); unknown keys are ignored.
- Config file written with `0600` in a `0700` directory (POSIX where supported).

---

## 10. Validation Gates (do these first)

These were resolved during Phase 0 by diffing OMP's published `@oh-my-pi/pi-coding-agent@16.3.0`
type declarations against Pi's `@earendil-works/pi-coding-agent@0.80.2`, plus a runtime load test.

1. **Event parity — PASS.** All agent/provider/message/tool/turn events survive (see §4). The two
   pi-langfuse events that did not survive have clean fallbacks: `model_select` → `ctx.model`;
   `session_before_fork` → `session_before_branch`. No re-architecture needed.
2. **`ctx` surface — PASS.** `sessionManager.getSessionFile()`, `ui.{notify,input,confirm,select}`,
   `hasUI`, `model`, `cwd` all present on `ExtensionContext`. (`ctx.mode` was dropped — unused.)
3. **Manifest discovery — PASS.** `omp -e ./index.ts` loaded the extension and ran the factory
   at runtime (confirmed). `omp.extensions` is the correct manifest key; no keyword required.
4. **Config dir — HIGH confidence.** Docs + OMP's own messages reference `~/.omp/agent/`
   (e.g. `~/.omp/agent/models.yml`). To be confirmed the first time the port writes config.
5. **Peer dep / types resolution — PASS with a gotcha.** `@oh-my-pi/pi-coding-agent` ships first-
   class types, so **no type shim is needed** (pi-langfuse's shim is obsolete). *Gotcha:* OMP's
   `ExtensionAPI` is **not exported from the package root** — a wildcard re-export collision drops
   it (OMP's own `examples/extensions/hello.ts` imports it from root and would fail to typecheck
   against their published types). Import it from the deep subpath:
   `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"`.
   This is validated: `tsc --noEmit` passes against real OMP types.

**Live event trace — PASS.** Ran `omp -e ./index.ts -p "..."` with a tool-using prompt against a
configured provider (`zai` / `glm-5.2`). Every required event fired with rich payloads, in order:
`session_start`→`before_agent_start`→`agent_start`→`turn_start`→`context`→`before_provider_request`→
`after_provider_response`→`message_update`×N→`message_end`→`tool_call`→`tool_execution_start`→
`tool_result`→`tool_execution_end`→`turn_end`→(2nd turn)→`session_stop`→`agent_end`→`session_shutdown`.

Key live findings that affect the port:
- **Usage + token counts are fully captured** on every assistant `message_end`:
  `message.usage = { input, output, cacheRead, cacheWrite, totalTokens, cost: {...} }`. Token counts
  are the basis for cost. The host `cost` field is **zeroed for subscription models** and will be
  ignored (see §8.1) — the extension computes cost itself.
- **`before_provider_request.payload`** carries the full request body (`model, messages, system,
  tools, metadata, max_tokens, thinking, context_management, stream`) — ideal generation input.
- **Session-id discovery needs a fallback.** `ctx.sessionManager.getSessionFile()` returns
  `undefined` in ephemeral/`--no-session` mode. OMP's new `session_stop` event carries `session_id`
  directly, but it fires at *end* of run. The port must (a) keep pi-langfuse's file-derived id when a
  session file exists, and (b) generate/use a fallback id for ephemeral runs (assign lazily, or
  promote the `session_stop.session_id` when it arrives late).
- **`after_provider_response.requestId` is provider-dependent** (`null` for `zai`; the `x-log-id`
  header carries an id). The reliable per-request id is `message.responseId`, already used by
  pi-langfuse. Provider metadata capture stays opportunistic.
- **Events can fire out of strict order** — some `message_update` streaming deltas log after
  `agent_end`/`session_shutdown`. The port's state machine must be robust to late events (pi-langfuse
  already guards with `if (state.agentState)` checks — preserve those).

### Breaking changes the port must apply (all minor)

| # | Change | Where it bites | Fix |
|---|---|---|---|
| 1 | `model_select` removed | `index.ts` handler that set `state.currentModel/Provider` | read `ctx.model` in `before_agent_start`/`turn_start` (utils already fall back to `ctx.model`) |
| 2 | `session_before_fork` → `session_before_branch` | session-interruption handler | rename the subscription; payload is `{ type, entryId }` |
| 3 | `BeforeAgentStartEvent.systemPrompt` `string`→`string[]` | system-prompt capture (privacy) | `.join("\n")` or capture as array |
| 4 | `SessionStartEvent`/`SessionShutdownEvent` simplified | fields pi-langfuse ignores | no-op |
| 5 | `args`/`result` typed `unknown` (was `any`) | handler param typing | cast at use site |
| 6 | `ctx.mode` removed from `ExtensionContext` | not used by pi-langfuse | no-op |
| 7 | `message.usage.cost` is host-computed & **zeroed for subscription models** (glm-5.2 returns `cost.total=0`) | generation cost capture — pi-langfuse trusted `usage.cost` | **do NOT trust `usage.cost`**; recompute cost from `usage.{input,output,cacheRead,cacheWrite}` tokens × resolved per-token price (§8.1). ✅ implemented in `src/pricing.ts` + wired into `generation.ts` |
| 8 | `ctx.model.cost` is **per-token**, not per-Mtok (per `ProviderModelConfig` docstring) | pricing resolver step 4 would be 1,000,000× off | `resolvePrice` multiplies registry rate by `PRICE_PER_MILLION` before returning ✅ |
| 9 | `BeforeAgentStartEvent.systemPromptOptions` **dropped** in OMP | `agent.ts` derived `cwd` from it | prefer `ctx.cwd` (falls back to `systemPromptOptions.cwd` then `process.cwd()`) ✅ |
| 10 | `ExtensionAPI` not exported from package root | import fails against published types | deep subpath import `@oh-my-pi/pi-coding-agent/extensibility/extensions/types` ✅ |
| **11** | **OMP runs on Bun, which cannot resolve the Langfuse/OTel dependency graph from `node_modules` at runtime** (top-level direct imports work, but a `node_modules` package importing a sibling `@opentelemetry/*` from deep in its own `build/` tree fails: `Cannot find module '@opentelemetry/core'`). Not version skew — proven by reproducing with all OTel 2.x pinned to a single 2.8.0. This is the cross-runtime incompatibility the project was created to handle. | the entire OTel + Langfuse SDK init path crashes (`Failed to create agent observation`) | **bundle the extension**: esbuild inlines `index.ts` + `src/` + all deps into a single self-contained `dist/index.js`; `omp.extensions` points at the bundle. Build-time resolution (correct Node semantics) replaces Bun's broken runtime resolution. ✅ verified — bundle inits cleanly under omp |

---

## 11. Implementation Phases

**Phase 0 — Scaffold & validate ✅ DONE.**
- `package.json` (`omp.extensions`, `omp-langfuse`, peer dep `@oh-my-pi/pi-coding-agent`),
  `tsconfig.json`, `.gitignore`, and a probe `index.ts` that subscribes to every required event
  plus the valuable OMP-new events, logs bounded payloads, and dumps the `ctx` surface.
- **No type shim needed** — OMP ships first-class types. `ExtensionAPI` imported from the deep
  subpath (see §10 gate 5). `tsc --noEmit` passes; `omp -e ./index.ts` loads at runtime.
- All §10 gates resolved. Remaining: live event trace (needs a configured model).

**Phase 1 — Mechanical port + cost module + Bun bundling ✅ DONE.**
- Copied `src/**`, `test/**` from `pi-langfuse`; dropped the obsolete `types/` shim (OMP ships types).
- Applied all 11 breaking-change fixes from §10 — most critically #11: **the extension is bundled**
  (`npm run build` → `dist/index.js`) because OMP's Bun runtime cannot resolve the Langfuse/OTel
  dependency graph from `node_modules`. Without bundling the OTel SDK crashes on init.
- Added `src/pricing.ts` (§8.1): bundled table, resolver, cost compute, one-time "no price" warning.
- Wired `config.pricing` (§7.4) into load/save, `/langfuse-status`, and privacy-save.
- Dev workflow: edit `index.ts`/`src/**` → `npm run build` → run `omp -e ./dist/index.js`.
  `omp.extensions` points at the bundle; typecheck + 43 unit tests run against unbundled source.
- `tsc --noEmit` green; **43/43 tests pass**; bundle loads & inits cleanly under omp (verified with
  dummy creds — only network errors against the fake host remain).
- **End-to-end verified ✅** — `omp -e ./dist/index.js -p "use bash to run: echo hi"` against a real
  self-hosted Langfuse produced a trace with a populated cost figure. The full pipeline (OMP events →
  trace tree → generations/tools → self-computed cost → Langfuse) works on the Bun runtime via the
  bundle.

**Phase 2 — Behavior port + tests.**
- Port unit tests; ensure `state.ts`, `config.ts`, `capture-policy.ts`, `redaction.ts`,
  `utils.ts`, `observation.ts` pass unchanged (they are host-agnostic).
- Wire handlers to the validated OMP events; adapt any event whose payload differs.

**Phase 3 — Integration validation.**
- `omp install ./omp-langfuse` (or `--extension`); run `omp -p '...'`; verify in Langfuse:
  trace per prompt, root agent I/O, generation + tool nesting, scores, tool-error levels,
  shutdown/interruption flush.

**Phase 4 — Polish & publish.**
- README (OMP CLI/paths), skill bundle (optional), marketplace catalog entry, npm publish as
  `omp-langfuse`.

---

## 12. Open Questions

1. Does OMP want a specific keyword (e.g. `omp-package`) for marketplace discovery, or is the
   `omp.extensions` manifest + directory convention sufficient?
2. Do we keep the bundled `.agents/skills/langfuse` CLI skill, and should it move under OMP's
   `skills/` convention per the authoring doc's directory discovery?
3. npm publish name: `omp-langfuse` (assumed) vs an `@oh-my-pi/` scope — confirm ownership.
4. Keep trace name `pi-agent` for continuity with existing Langfuse projects, or rename to
   `omp-agent`? (Draft chooses `omp-agent`; trivially reversible.)
5. Should source-metadata override file be named `.omp-langfuse.metadata.json` (chosen) for
   consistency, even though it diverges from pi-langfuse's `.pi-langfuse.metadata.json`?

---

## 13. References

- OMP extension authoring: https://omp.sh/docs/extension-authoring
- OMP hooks: https://omp.sh/docs/hooks
- OMP npm package: `@oh-my-pi/pi-coding-agent`
- Predecessor (Pi): https://github.com/gooyoung/pi-langfuse (v1.5.6)
- Langfuse SDKs: `@langfuse/tracing`, `@langfuse/otel`, `@langfuse/client`
