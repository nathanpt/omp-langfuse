/**
 * Role inference for provider requests: distinguishes the primary agent from
 * the advisor (a second Agent inside the same AgentSession whose provider
 * requests flow through the same lifecycle hooks, indistinguishable in the
 * typed events themselves).
 *
 * Two independent signals:
 * 1. Tools marker (always available): OMP unconditionally prepends the
 *    `advise` tool to every advisor agent's toolset, and tool definitions are
 *    serialized into every provider payload (anthropic: `tools[].name`;
 *    openai: `tools[].function.name`). Primary and side calls never include it.
 * 2. OTel active span (only when OMP runs with OTEL_EXPORTER_OTLP_ENDPOINT):
 *    the host wraps every provider call in a GenAI `chat` span carrying
 *    `gen_ai.agent.id` (`<session>-advisor[:slug]` for the advisor) and
 *    `gen_ai.agent.name` (`Advisor: <name>`). Never load-bearing — best-effort
 *    enrichment only.
 */

import { trace } from "@opentelemetry/api";

export type GenerationRole = "default" | "advisor";

/** Collect tool names from a provider payload, across both wire dialects. */
export function getToolNames(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const tools = (payload as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) {
    return [];
  }

  const names: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }
    const def = tool as Record<string, unknown>;
    const fn = def.function;
    const raw = def.name ?? (fn && typeof fn === "object" ? (fn as Record<string, unknown>).name : undefined);
    if (raw === undefined || raw === null) {
      continue;
    }
    const name = String(raw);
    if (name) {
      names.push(name);
    }
  }
  return names;
}

/** Infer the requesting role from the payload's serialized toolset. */
export function inferGenerationRole(payload: unknown): GenerationRole {
  return getToolNames(payload).includes("advise") ? "advisor" : "default";
}

/** Extract the true per-request model id from the provider payload. */
export function extractPayloadModel(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const model = (payload as Record<string, unknown>).model;
  return typeof model === "string" && model ? model : undefined;
}

export interface OtelRoleHint {
  /** Present only when an agent-id/name attribute exists on the active span. */
  role?: GenerationRole;
  /** `gen_ai.agent.name` when it names an advisor. */
  advisorName?: string;
  /** `pi.gen_ai.oneshot.kind` (compaction/title/… side calls). */
  oneshotKind?: string;
}

/**
 * Read role hints from the OTel span the host opened around this provider
 * call. Returns undefined when there is no active span with attributes — the
 * default path when OMP runs without `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * @param _currentSessionId Reserved for session-scoped `<session>-advisor`
 *   matching; the generic `-advisor` marker is sufficient on OMP 16.3.0.
 */
export function readOtelRoleHint(_currentSessionId: string): OtelRoleHint | undefined {
  const span = trace.getActiveSpan();
  // The public Span interface does not expose `attributes` (SDK spans carry it
  // at runtime; no-op tracer spans simply lack the field and fall through).
  const attrs = (span as unknown as { attributes?: Record<string, unknown> } | undefined)?.attributes;
  if (!attrs) {
    return undefined;
  }

  const agentId = String(attrs["gen_ai.agent.id"] ?? "");
  const agentName = String(attrs["gen_ai.agent.name"] ?? "");
  const isAdvisor = agentId.includes("-advisor") || agentName.startsWith("Advisor");

  const role: GenerationRole | undefined = isAdvisor ? "advisor" : agentId ? "default" : undefined;
  const oneshotAttr = attrs["pi.gen_ai.oneshot.kind"];
  const oneshotKind = typeof oneshotAttr === "string" ? oneshotAttr : undefined;

  return {
    ...(role ? { role } : {}),
    ...(role === "advisor" && agentName ? { advisorName: agentName } : {}),
    ...(oneshotKind ? { oneshotKind } : {}),
  };
}
