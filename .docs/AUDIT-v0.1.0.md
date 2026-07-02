# Live trace audit — v0.1.0

Verification of the full OMP → Langfuse pipeline against a real self-hosted Langfuse instance
(`http://192.168.0.21:3000`), using the project's default model `zai/glm-5.2`.

> Run date: 2026-07-02. Built from `dist/index.js` (esbuild bundle).

## What was verified

A multi-turn, multi-tool prompt that includes an intentional tool failure (non-zero bash exit), run
via `omp -e ./dist/index.js`. The canonical trace is `c6bd004cad47dca7084831c30acac945`.

### Result: 9 observations, all attributes correct

| # | Observation | type | key attributes |
| --- | --- | --- | --- |
| 1 | `omp-agent` | agent (root) | input = user prompt; output = final assistant response; metadata has hashed cwd, `model=glm-5.2`, `provider=zai`, `source_type=non-git` |
| 2–4 | `llm-generation` ×3 | generation | `model=glm-5.2`, usage tokens + self-computed `costDetails` (see below) |
| 5–7 | `turn` ×3 | span | one per agent turn |
| 8 | `bash` (success) | tool | `level=DEFAULT`, `isError=false` |
| 9 | `bash` (failure) | tool | `level=ERROR`, `isError=true`, `statusMessage="Command exited with code 1"` |

### Trace-level scores (all correct)

| score | value | datatype |
| --- | --- | --- |
| `tool_call_count` | 2 | NUMERIC |
| `turn_count` | 3 | NUMERIC |
| `total_tool_errors` | 1 | NUMERIC |
| `tool_success_rate` | 0.5 | NUMERIC |
| `session_had_errors` | 1 | BOOLEAN |
| `tool_is_error` | 1 | BOOLEAN (observation-level, attached to the failing tool) |

### Self-computed cost (all correct)

Cost is never trusted from host `usage.cost` (zeroed for `glm-5.2`). It is recomputed from token
counts × the resolved per-token price and lands as `costDetails` on each generation, with
`calculatedTotalCost` mirroring our `total`. Model resolved via the `glm` family-prefix rate
(`f(0.43, 1.74, 0.08)`).

Example generation `costDetails`:
```json
{ "input": 0.00018146, "output": 0.0003306, "cacheRead": 0.00189952, "cacheWrite": 0, "total": 0.00241158 }
```

Arithmetic check (gen with input=142, output=125, cacheRead=23808):
- input: 142 × 0.43 / 1e6 = 0.0000611 ✓
- output: 125 × 1.74 / 1e6 = 0.0002175 ✓
- cacheRead: 23808 × 0.08 / 1e6 = 0.00190464 ✓

The `cacheRead` breakdown is populated correctly (OMP reports cache-read tokens separately).

### Other findings

- **Trace name** is `omp-agent` (open question Q4 — confirmed and kept).
- **Source metadata** records `source_type: non-git`, `metadata_source: non-git` for the audit run
  (the run cwd was outside a git worktree). Git-repo runs populate `git_branch`, `git_commit`,
  `repo_identity`, etc.
- **Privacy/redaction** confirmed in the metadata: `cwd` is hashed to `[PATH_HASH:…]]`, not stored
  raw. Secret/path redaction applied to all payloads.
- **REST fallback** did not fire — OTel ingestion materialized traces on its own, so the fallback
  path was not exercised this run (it remains as a safety net for self-hosted instances where OTel
  alone is insufficient).

## Bug found and fixed during this audit

**Tool error detection missed non-zero bash exits.**

OMP reports a bash command that runs to completion but exits non-zero via `event.details.exitCode`
while leaving `event.isError = false` (the *tool* executed fine; only the *command* failed). The
original error check only looked at `event.isError` / `event.error` / `event.status`, so a failing
`cat`/`ls`/etc. was recorded as a successful tool call and excluded from the error scores.

**Fix** (`src/handlers/tool.ts`): the error check now also treats a non-zero `event.details.exitCode`
as an error, sets `level=ERROR` + `isError=true`, emits `statusMessage="Command exited with code N"`,
and increments `errorCount` so the trace-level error scores reflect the failure. Verified in the
canonical trace above (the failing `bash` observation is `level=ERROR`, `tool_is_error=1`).

## Conclusion

The v0.1.0 pipeline is verified end-to-end: generation usage + self-computed cost, tool error
flagging (including non-zero exits), and all trace-level scores land correctly in Langfuse for the
default model (`glm-5.2`) on a multi-turn, multi-tool run with an error path.
