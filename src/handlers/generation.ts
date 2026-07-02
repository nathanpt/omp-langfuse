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

/**
 * Self-compute generation cost from token usage × resolved price (design §8.1).
 * Never trusts host `usage.cost` (zeroed for subscription models). Returns undefined
 * when no price resolves for the model (warns once).
 */
function computeGenerationCost(message: Record<string, unknown>, modelId: string): Record<string, number> | undefined {
  const usage = extractUsage({ message });
  if (!usage) {
    return undefined;
  }
  const price = resolvePrice(modelId, state.config?.pricing, state.currentModelCost);
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

export function getOpenGeneration(): GenerationState | undefined {
  if (state.isTracingDisabled || !state.agentState) {
    return undefined;
  }

  for (let i = state.agentState.generationOrder.length - 1; i >= 0; i--) {
    const key = state.agentState.generationOrder[i];
    const genState = state.agentState.activeGenerations.get(key);
    if (genState && !genState.ended) {
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
    const modelParameters = extractModelParameters(payload);
    const model = String(event.model ?? event.modelId ?? state.currentModel ?? "");
    const provider = String(event.provider ?? state.currentProvider ?? "");
    const metadata = shapePayload({
      provider,
      requestId: key,
      url: event.url,
      method: event.method,
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
      name: "llm-generation",
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
      metadata: captured.metadata ?? {},
      modelParameters,
    });
    state.agentState.generationOrder.push(key);
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
  const costDetails = computeGenerationCost(message, model);
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
    const costDetails = computeGenerationCost(message, model);
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
