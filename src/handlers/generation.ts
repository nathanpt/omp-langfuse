import { state } from "../state.js";
import { getRuntime } from "../langfuse.js";
import { startChildObservation } from "../observation.js";
import {
  getRequestKey,
  getProviderPayload,
  shapePayload,
  extractResponseMetadata,
  getMessageFromEvent,
  extractAssistantOutput,
  extractUsage,
  getCapturePolicy,
  extractModelParameters,
} from "../utils.js";
import { resolvePrice, computeCost, warnOnceNoPrice } from "../pricing.js";
import type { GenerationState, ObservationUpdate } from "../types.js";
import { applyCapturePolicy } from "../capture-policy.js";
import {
  extractPayloadModel,
  inferGenerationRole,
  readOtelRoleHint,
} from "../role.js";
import type { GenerationRole } from "../role.js";

/**
 * Self-compute generation cost from token usage × resolved price.
 * Never trusts host `usage.cost` (zeroed for subscription models). Returns undefined
 * when no price resolves for the model (warns once).
 *
 * The catalog (registry) rate describes the primary's current model; pass
 * `useRegistryRate = false` for any generation whose model may differ (e.g. the
 * advisor's), so the primary's rate cannot leak onto another model.
 */
export function computeGenerationCost(
  message: Record<string, unknown>,
  modelId: string,
  useRegistryRate = true,
): Record<string, number> | undefined {
  const usage = extractUsage({ message });
  if (!usage) {
    return undefined;
  }
  const price = resolvePrice(modelId, state.config?.pricing, useRegistryRate ? state.currentModelCost : undefined);
  if (!price) {
    warnOnceNoPrice(modelId);
    return undefined;
  }
  const cost = computeCost(usage, price);
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    total: cost.total,
  };
}

/**
 * Most-recent open generation, searching backwards. Primary-only by default:
 * advisor generations never receive `message_end` events, so a primary
 * assistant message must not swallow an in-flight advisor generation, and
 * primary stream updates must not steal advisor TTFT. Pass
 * `{ includeAdvisor: true }` to consider them.
 */
export function getOpenGeneration(options?: { includeAdvisor?: boolean }): GenerationState | undefined {
  if (state.isTracingDisabled || !state.agentState) {
    return undefined;
  }

  for (let i = state.agentState.generationOrder.length - 1; i >= 0; i--) {
    const key = state.agentState.generationOrder[i];
    const genState = state.agentState.activeGenerations.get(key);
    if (genState && !genState.ended && (options?.includeAdvisor || genState.role !== "advisor")) {
      return genState;
    }
  }

  return undefined;
}

export async function startGeneration(event: Record<string, unknown>) {
  if (state.isTracingDisabled || !state.agentState?.root) {
    return;
  }

  try {
    const key = getRequestKey(event, `generation-${++state.agentState.generationSeq}`);
    const payload = getProviderPayload(event);
    const otelHint = readOtelRoleHint(state.currentSessionId);
    const role: GenerationRole = otelHint?.role ?? inferGenerationRole(payload);
    const modelParameters = extractModelParameters(payload);
    const model = String(event.model ?? event.modelId ?? extractPayloadModel(payload) ?? state.currentModel ?? "");
    const provider = String(event.provider ?? state.currentProvider ?? "");
    const metadata = shapePayload({
      provider,
      requestId: key,
      url: event.url,
      method: event.method,
      ...(role !== "default" ? { role } : {}),
      ...(otelHint?.advisorName ? { advisor: otelHint.advisorName } : {}),
      ...(otelHint?.oneshotKind ? { oneshotKind: otelHint.oneshotKind } : {}),
    }) as Record<string, unknown>;
    const captured = applyCapturePolicy(
      {
        input: shapePayload(payload),
        metadata,
      },
      getCapturePolicy(),
    );

    const parent = state.agentState.activeTurn ?? state.agentState.root;
    const generation = await startChildObservation({
      parent,
      runtime: getRuntime,
      name: role === "advisor" ? "llm-generation:advisor" : "llm-generation",
      body: {
        input: captured.input,
        model: model || undefined,
        modelParameters,
        metadata: captured.metadata,
      },
      asType: "generation",
    });

    state.agentState.activeGenerations.set(key, {
      observation: generation,
      requestKey: key,
      ended: false,
      role,
      model: model || undefined,
      metadata: captured.metadata ?? {},
      modelParameters,
    });
    state.agentState.generationOrder.push(key);
    if (role === "advisor") {
      // Advisor assistant messages never reach message_end; usage is reconciled
      // later from the advisor transcript (src/handlers/advisor.ts).
      state.agentState.pendingAdvisorGenerations.push(key);
    }
    if (!state.agentState.rolesSeen.has(role)) {
      state.agentState.rolesSeen.add(role);
      state.agentState.root?.update({ metadata: { roles: [...state.agentState.rolesSeen] } });
    }
  } catch (e) {
    console.warn("📊 Langfuse: Failed to start generation", e);
  }
}

export function updateGenerationMetadata(event: Record<string, unknown>) {
  if (state.isTracingDisabled || !state.agentState) {
    return;
  }

  const key = getRequestKey(event, "");
  const metadata = applyCapturePolicy({ metadata: extractResponseMetadata(event) }, getCapturePolicy()).metadata ?? {};
  if (!key) {
    const generation = getOpenGeneration();
    if (generation) {
      generation.metadata = { ...generation.metadata, ...metadata };
      
      const isError = 
        (typeof metadata.status === "number" && metadata.status >= 400) || 
        event.error || 
        event.isError;
        
      if (isError) {
        generation.observation.update({ 
          metadata: generation.metadata,
          level: "ERROR",
          statusMessage: String(event.error ?? metadata.statusMessage ?? "Provider request failed")
        }).end();
        generation.ended = true;
      } else {
        generation.observation.update({ metadata: generation.metadata });
      }
    }
    return;
  }

  const generation = state.agentState.activeGenerations.get(key) ?? getOpenGeneration();
  if (generation) {
    generation.metadata = { ...generation.metadata, ...metadata };
    
    const isError = 
      (typeof metadata.status === "number" && metadata.status >= 400) || 
      event.error || 
      event.isError;
      
    if (isError) {
      generation.observation.update({ 
        metadata: generation.metadata,
        level: "ERROR",
        statusMessage: String(event.error ?? metadata.statusMessage ?? "Provider request failed")
      }).end();
      generation.ended = true;
    } else {
      generation.observation.update({ metadata: generation.metadata });
    }
  }
}

export function recordTTFT(event: Record<string, unknown>) {
  if (state.isTracingDisabled || !state.agentState) {
    return;
  }

  const key = getRequestKey(event, "");
  const generation = key ? state.agentState.activeGenerations.get(key) : getOpenGeneration();
  
  if (generation && !generation.ttftRecorded && !generation.ended) {
    generation.ttftRecorded = true;
    try {
      generation.observation.update({ completionStartTime: new Date() });
    } catch (e) {
      // Ignore
    }
  }
}

export async function finishGenerationFromMessage(event: Record<string, unknown>) {
  if (state.isTracingDisabled || !state.agentState) {
    return;
  }

  const message = getMessageFromEvent(event);
  if (!message || message.role !== "assistant") {
    return;
  }

  const generation = getOpenGeneration();
  const rawOutput = extractAssistantOutput(message);
  const captured = applyCapturePolicy({ output: rawOutput }, getCapturePolicy());
  const output = captured.output;
  state.agentState.latestAssistantOutput = output;

  if (!generation) {
    return;
  }

  const usageDetails = extractUsage({ ...event, message });
  const model = String(message.model ?? event.model ?? state.currentModel ?? "");
  const useRegistryRate = model.trim().toLowerCase() === state.currentModel.trim().toLowerCase();
  const costDetails = computeGenerationCost(message, model, useRegistryRate);
  const modelParameters = extractModelParameters(getProviderPayload(event)) ?? generation.modelParameters;
  const update: ObservationUpdate = {
    output,
    model: model || undefined,
    modelParameters,
    usageDetails,
    ...(costDetails ? { costDetails } : {}),
    metadata: {
      ...generation.metadata,
      finishReason: message.finishReason ?? message.stopReason ?? event.finishReason,
    },
  };
  update.metadata = applyCapturePolicy({ metadata: update.metadata }, getCapturePolicy()).metadata;

  try {
    generation.observation.update(update).end();
    generation.ended = true;
  } catch (e) {
    console.warn("📊 Langfuse: Failed to finish generation", e);
  }
}

export async function createFallbackGenerationFromTurn(event: Record<string, unknown>, message: Record<string, unknown>) {
  if (state.isTracingDisabled || !state.agentState?.root || state.agentState.generationOrder.length > 0) {
    return;
  }

  try {
    const usageDetails = extractUsage({ ...event, message });
    const model = String(message.model ?? event.model ?? state.currentModel ?? "");
    const useRegistryRate = model.trim().toLowerCase() === state.currentModel.trim().toLowerCase();
    const costDetails = computeGenerationCost(message, model, useRegistryRate);
    const modelParameters = extractModelParameters(getProviderPayload(event));
    const captured = applyCapturePolicy(
      {
        input: state.agentState.promptInput,
        output: extractAssistantOutput(message),
        metadata: {
          provider: state.currentProvider || undefined,
          sourceEvent: "turn_end",
        },
      },
      getCapturePolicy(),
    );
    const parent = state.agentState.activeTurn ?? state.agentState.root;
    const generation = await startChildObservation({
      parent,
      runtime: getRuntime,
      name: "llm-generation",
      body: {
        input: captured.input,
        output: captured.output,
        model: model || undefined,
        modelParameters,
        usageDetails,
        ...(costDetails ? { costDetails } : {}),
        metadata: captured.metadata,
      },
      asType: "generation",
    });

    generation.end();
    state.agentState.generationOrder.push("turn-end-fallback");
  } catch (e) {
    console.warn("📊 Langfuse: Failed to create fallback generation", e);
  }
}
