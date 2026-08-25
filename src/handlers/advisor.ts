/**
 * Advisor usage reconciliation.
 *
 * Advisor assistant messages never reach the extension's `message_end` events
 * (only the primary agent's events are forwarded), so advisor generations
 * would dangle open and close empty. But `AdvisorTranscriptRecorder` appends
 * every advisor assistant message — with `usage` + `model` — to
 * `<sessionFile minus .jsonl>/__advisor[.<slug>].jsonl`. This module tails
 * those files (session-scoped byte offsets) and closes the pending advisor
 * generations FIFO: one assistant record closes one generation.
 *
 * Called at `turn_start` (catches advisor turns that completed after the
 * previous turn ended) and `agent_end` (most advisor drains complete before
 * the primary run ends).
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { state } from "../state.js";
import { extractUsage } from "../utils.js";
import { computeGenerationCost } from "./generation.js";

const ADVISOR_TRANSCRIPT_RE = /^__advisor\..+\.jsonl$/;

/** `__advisor.jsonl` → undefined; `__advisor.<slug>.jsonl` → `<slug>`. */
function advisorSlug(file: string): string | undefined {
  return file === "__advisor.jsonl" ? undefined : file.slice("__advisor.".length, -".jsonl".length);
}

export async function reconcileAdvisorUsage(): Promise<void> {
  try {
    if (state.isTracingDisabled || !state.agentState?.root) {
      return;
    }
    const agentState = state.agentState;
    if (agentState.pendingAdvisorGenerations.length === 0) {
      return; // no FS work in the common no-advisor case
    }
    const sessionFile = state.sessionFilePath;
    if (!sessionFile || !sessionFile.endsWith(".jsonl")) {
      return;
    }

    const dir = sessionFile.slice(0, -".jsonl".length);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((n) => n === "__advisor.jsonl" || ADVISOR_TRANSCRIPT_RE.test(n));
    } catch {
      return; // no advisor transcript directory — nothing to reconcile
    }
    files.sort();

    for (const file of files) {
      const slug = advisorSlug(file);
      const content = await readFile(join(dir, file), "utf8");
      const consumable = content.lastIndexOf("\n") + 1; // complete lines only
      const offsets = state.advisorTranscriptOffsets;
      const chunk = content.slice(offsets.get(file) ?? 0, consumable);
      offsets.set(file, consumable);

      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue; // malformed line — skip without failing reconciliation
        }
        // Records are `{type:"message", message:{role, model, usage}}` envelopes
        // from the recorder; accept a flat message too.
        const message =
          record.message && typeof record.message === "object"
            ? (record.message as Record<string, unknown>)
            : record;
        if (message.role !== "assistant") {
          continue;
        }

        // One assistant record closes one pending generation, oldest first.
        // Records with no pending generation (advisor activity predating this
        // run) are consumed and dropped.
        while (agentState.pendingAdvisorGenerations.length > 0) {
          const key = agentState.pendingAdvisorGenerations.shift() as string;
          const gen = agentState.activeGenerations.get(key);
          if (!gen || gen.ended) {
            continue;
          }

          const usageDetails = extractUsage({ message });
          const model = String(message.model ?? gen.model ?? "");
          const modelMatchesCurrent = model.trim().toLowerCase() === state.currentModel.trim().toLowerCase();
          const costDetails = computeGenerationCost(message, model, modelMatchesCurrent);

          gen.observation
            .update({
              usageDetails,
              model: model || undefined,
              ...(costDetails ? { costDetails } : {}),
              metadata: { ...gen.metadata, role: "advisor", ...(slug ? { advisor: slug } : {}) },
            })
            .end();
          gen.ended = true;

          agentState.advisorTotals.generations += 1;
          agentState.advisorTotals.costUsd += costDetails?.total ?? 0;
          if (usageDetails) {
            agentState.advisorTotals.tokens +=
              usageDetails.input +
              usageDetails.output +
              (usageDetails.cacheRead ?? 0) +
              (usageDetails.cacheWrite ?? 0);
          }
          break;
        }
      }
    }
  } catch (e) {
    console.warn("📊 Langfuse: advisor usage reconciliation failed", e);
  }
}
