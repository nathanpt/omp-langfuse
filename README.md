# omp-langfuse

Langfuse observability extension for **[OMP](https://omp.sh)** (oh-my-pi), the Pi fork.

Sends one complete **Langfuse trace per OMP agent run**:

- a root **agent** observation for the user prompt and final assistant response
- one **generation** observation per provider request, with self-computed token usage **and cost**
- one **tool** observation per tool call (including failures)

Ported from [`pi-langfuse`](https://github.com/gooyoung/pi-langfuse) (v1.5.6) and adapted for OMP's
Bun runtime and its divergences from Pi. See [`CHANGELOG.md`](./docs/CHANGELOG.md) for release
history.

> **Status:** v0.3.3 — installable as an OMP plugin via Git, with self-computed cost accurate for
> paid models (via the OMP catalog) and for subscription models (researched rates). npm publish is
> not supported by OMP's install surface, so Git is the distribution path.

---

## Why self-computed cost?

OMP's host-reported `usage.cost` is computed from the model registry's rates, which are **zeroed for
subscription / free-tier models** (e.g. `glm-5.2` returns `cost.total = 0`). So omp-langfuse never
trusts host cost: cost is always recomputed from the populated token counts
(`usage.{input,output,cacheRead,cacheWrite}`) × a resolved per-token price. See
[`src/pricing.ts`](./src/pricing.ts).

---

## Install

omp-langfuse is an OMP **plugin**.

### Prerequisite: bun

**A GitHub-source install requires [`bun`](https://bun.sh) in `$PATH`.** OMP's github-source
install path runs a build/install step (bun-based); without bun it fails with
`Executable not found in $PATH: "bun"`.

```bash
# install bun if you don't have it
curl -fsSL https://bun.sh/install | bash
```

The published package ships a pre-built `dist/index.js`, so once installed there is no build step
at runtime — bun is only needed for the install step itself.

**Install from GitHub:**

```bash
omp install github:nathanpt/omp-langfuse#v0.3.3
```

(See the [releases](https://github.com/nathanpt/omp-langfuse/releases) page for the latest tag;
drop the `#tag` to track the default branch.)

Other equivalent sources:

```bash
omp install https://github.com/nathanpt/omp-langfuse.git   # tracks default branch (needs bun)
omp install ./omp-langfuse                                    # local clone / dev (symlinks; no bun needed)
```

Confirm it loaded with `omp -p '/extensions'`; uninstall with `omp remove omp-langfuse`.

> OMP's marketplace/install surface does **not** currently support npm sources (per the omp docs),
> so omp-langfuse is distributed via Git, not npm.

### Run it

Once installed, the extension loads automatically on every OMP session and you'll see
`📊 Langfuse: Tracing enabled → <host>` at startup. Slash commands (`/langfuse-setup`, etc.) are
registered automatically. See [Configure](#configure) for first-run setup.

For development / one-shot runs without installing:

```bash
omp -e ./dist/index.js -p "your prompt"
```

### Dev workflow

```bash
npm run typecheck    # tsc --noEmit against OMP types
npm test             # unit tests
npm run build        # esbuild bundle -> dist/index.js (committed for installs)
omp -e ./dist/index.js -p "..."   # one-shot run against a live OMP
```

---

## Configure

Credentials are resolved in this order:

1. **Config file** at `~/.omp/agent/omp-langfuse/config.json` (dir `0700`, file `0600`).
2. **Environment variables**: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`,
   `LANGFUSE_BASE_URL` (or `LANGFUSE_HOST`).

The file is created for you on first run if you run OMP in interactive/UI mode — the extension
prompts for your keys. In headless mode, set the env vars or write the file by hand.

### Config file shape

```jsonc
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "host": "https://cloud.langfuse.com",   // or your self-hosted URL

  // Optional: override the privacy preset persisted to this file
  "privacyPreset": "full-debug",

  // Optional: per-model pricing overrides (USD per 1M tokens)
  "pricing": {
    "glm-5.2": { "input": 1.4, "output": 4.4, "cacheRead": 0.26 }
  }
}
```

The default host is `https://cloud.langfuse.com`. For self-hosted Langfuse, set `host` to your
instance URL.

---

## Slash commands

OMP exposes these as `/langfuse-*` commands:

| Command | Description |
| --- | --- |
| `/langfuse-setup` | Prompt for API keys and save them to the config file. |
| `/langfuse-status` | Show configuration source, host, masked public key, privacy preset, capture flags, pricing-override count, active-run state, and last runtime error. |
| `/langfuse-test` | Send a test trace to Langfuse to verify connectivity and ingestion. |
| `/langfuse-privacy [preset=...]` | View or set the privacy preset (`metadata-only`, `prompts-only`, `conversations`, `full-debug`). |

`/langfuse-privacy` examples:
- `/langfuse-privacy` — show current preset (or pick from a menu in UI mode)
- `/langfuse-privacy preset=conversations`
- `/langfuse-privacy conversations`

---

## Privacy presets

Controls what gets captured into Langfuse. Defaults to `full-debug` when no preset is set.

| Preset | inputs | outputs | tool IO | system prompt | cwd |
| --- | --- | --- | --- | --- | --- |
| `metadata-only` | off | off | off | off | off |
| `prompts-only` | on | off | off | off | off |
| `conversations` | on | on | off | off | off |
| `full-debug` *(default)* | on | on | on | on | on |

Set via env var (`LANGFUSE_PRIVACY_PRESET=conversations`) or `/langfuse-privacy`. Individual flags
can also be overridden with env vars, which take precedence over the preset:

- `LANGFUSE_CAPTURE_INPUTS`
- `LANGFUSE_CAPTURE_OUTPUTS`
- `LANGFUSE_CAPTURE_TOOL_IO`
- `LANGFUSE_CAPTURE_SYSTEM_PROMPT`
- `LANGFUSE_CAPTURE_CWD`

Accepts `1/true/yes/on` and `0/false/no/off`.

### Redaction

Regardless of preset, all payloads are run through a redactor that scrubs:

- API keys / tokens (`sk-lf-…`, `sk-ant-…`, `pk-lf-…`, GitHub tokens, npm tokens, AWS keys,
  `Bearer …` headers)
- private keys (`-----BEGIN … PRIVATE KEY-----`)
- secret-looking assignments (`API_KEY=…`, `PASSWORD=…`, etc.)
- sensitive object fields (`authorization`, `token`, `password`, `apikey`, …)
- local absolute paths (`/home/user/…`, `/Users/…`, `C:\Users\…`) — hashed, not the raw path

Payloads are also size-limited (strings to 12 KB, tool payloads to 24 KB, depth 6, arrays 50 items,
objects 80 keys).

---

## Pricing

omp-langfuse resolves a per-token price per message with this precedence (first match wins):

1. **user config override** (exact model id, case-insensitive) — `config.pricing`
2. **bundled table** (exact id) — subscription/free-tier models the catalog zeroes
3. **bundled table** (longest family prefix)
4. **catalog rate** (`ctx.model.cost` from `@oh-my-pi/pi-catalog`, already $/Mtok) —
   authoritative for paid models; used directly with no conversion
5. none → cost is omitted, and a one-time warning is emitted per model

Paid models (OpenAI, Anthropic, Google, DeepSeek, …) are priced automatically from the OMP model
catalog at runtime — no bundled entries needed for them. The bundled table only covers models the
catalog deliberately zeroes because they're billed via subscription (e.g. **Zhipu GLM-5.x**); those
rates are researched from the provider's API listings. Rates are USD per 1,000,000 tokens.

```jsonc
{
  "pricing": {
    "glm-5.2":  { "input": 1.4, "output": 4.4, "cacheRead": 0.26 },
    "my-model": { "input": 1.0, "output": 3.0 }
  }
}
```

`cacheWrite` is optional and defaults to `0` (populated mainly for Anthropic). Pricing drifts over
time — for subscription models whose bundled rate falls out of date, override via `config.pricing`.

---

## Source / git metadata

The root agent observation records repo context so you can slice traces by project in Langfuse:

- `source_type` (`git-repo` or `non-git`), `git_branch`, `git_commit`
- `git_remote_host`, `git_remote_path`, `repo_identity` (`owner/name`), `repo_owner`, `repo_name`
- `repo_root_name`

You can override or add fields by dropping a `.omp-langfuse.metadata.json` file at the repo root (or
any directory up to the git root). Recognized keys: `repo_identity`, `repo_owner`, `repo_name`,
`source_type`, `service_name`, `project_slug`, `environment`, `observability_owner`.

---

## Trace model

| Observation | Type | One per | Notes |
| --- | --- | --- | --- |
| `omp-agent` | agent | agent run | Root. Input = user prompt; output = final assistant response. Trace name is also `omp-agent`. |
| `llm-generation` | generation | provider request | Usage + self-computed cost. |
| `turn` | span | agent turn | Wraps the generations and tool calls within a turn. |
| *(tool name)* | tool | tool call | Marked `level=ERROR` / `isError=true` on failure (including non-zero bash exits). |
| `session_compact` | span | context compaction | Recorded when the context window is compacted. |

**Trace name** is `omp-agent` (also the name of the root agent observation).

**Trace-level scores** (attached to the trace at `agent_end`):

- `tool_call_count`
- `turn_count`
- `total_tool_errors`
- `tool_success_rate` (0–1)
- `session_had_errors` (0/1)

---

## Troubleshooting

**No traces appear in Langfuse**
- Run `/langfuse-status`. Check `State: configured`, the host, and `Last error`.
- Run `/langfuse-test` to verify connectivity and ingestion with a standalone test trace.
- For self-hosted: confirm `host` is reachable from the OMP process and that OTel ingestion is
  enabled. The extension falls back to REST for self-hosted instances where OTel alone does not
  materialize traces.
- Check `LANGFUSE_*` env vars aren't overriding your config file with stale keys.

**Cost shows as 0 / missing**
- The model has no resolvable price (you'll see a one-time `no bundled price for model "…"`
  warning). Add an entry under `config.pricing`.
- For subscription/free-tier models the host always reports `cost.total = 0` — this is expected and
  why omp-langfuse recomputes cost.

**Tool failures not marked as errors**
- Confirm the privacy preset captures tool IO, or that the error surfaced through `tool_result` /
  `tool_execution_end`. Error level is derived from the tool result, not the IO payload.

**"Waiting for first-run setup"**
- No config file and no `LANGFUSE_*` env vars. Run `/langfuse-setup` (UI mode) or set the env vars.

---

## What's in the box

```
index.ts                  extension entry: lifecycle subscriptions + command registration
src/
  config.ts               credential loading/saving, UI setup flow
  capture-policy.ts       privacy presets + per-field capture flags + redaction application
  redaction.ts            secret/path redactor
  pricing.ts              per-token price resolution + cost computation
  source-metadata.ts      git + repo metadata collection (+ .omp-langfuse.metadata.json overrides)
  langfuse.ts             @langfuse/tracing + OTel runtime, REST fallback, score sending
  state.ts                per-session AsyncLocalStorage state + score aggregation
  handlers/               agent.ts, turn.ts, generation.ts, tool.ts observation builders
  commands.ts             /langfuse-* command handlers
  constants.ts            config paths, limits, defaults
test/                     unit tests (npm test)
dist/index.js             COMMITTED pre-built bundle (what OMP loads from a Git-source install)
docs/CHANGELOG.md         release history (source of truth for release notes)
AGENTS.md                 operating manual for agents + the release workflow
.github/workflows/ci.yml  CI: typecheck + test + build; releases on tag
```

---

## License

MIT.
