import { state, resetRunState, computeEvaluationScores, getSessionRunState } from "../state.js";
import { getRuntime, sendScore } from "../langfuse.js";
import { ensureConfig } from "../config.js";
import { shapePayload, truncate, extractFinalAssistant, extractAssistantOutput, getCapturePolicy } from "../utils.js";
import { closeDanglingObservations } from "./tool.js";
import { applyCapturePolicy } from "../capture-policy.js";
import { collectSourceMetadata } from "../source-metadata.js";
import { rememberParentTrace, lookupParentTrace } from "../parent-trace.js";
import { detectSubagentSession, subagentTraceName } from "../subagent.js";

const INMEM_SCOPE_PREFIX = "inmem:";

function stringMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!metadata) {
    return undefined;
  }

  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      output[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      output[key] = String(value);
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function updateTraceIO(input?: unknown, output?: unknown) {
  const root = state.agentState?.root;
  if (!root?.setTraceIO) {
    return;
  }

  try {
    root.setTraceIO({ input, output });
  } catch {
    // Older SDKs may omit setTraceIO; root IO still mirrors trace IO in current Langfuse.
  }
}

export async function startAgentRun(event: Record<string, unknown>, ctx: any) {
  if (!(await ensureConfig(ctx))) {
    state.isTracingDisabled = true;
    return;
  }

  try {
    const rt = await getRuntime();
    const cwd = String(
      (ctx && typeof ctx.cwd === "string"
        ? ctx.cwd
        : event.systemPromptOptions && typeof event.systemPromptOptions === "object"
          ? (event.systemPromptOptions as Record<string, unknown>).cwd
          : undefined) ?? process.cwd(),
    );

    if (!state.currentModel && ctx.model) {
      state.currentModel = ctx.model.id || "";
      state.currentProvider = ctx.model.provider || "";
    }

    let systemPrompt = undefined;
    try {
      if (ctx.getSystemPrompt) {
        systemPrompt = await ctx.getSystemPrompt();
      }
    } catch {
      // Ignore if getSystemPrompt is not available or fails
    }
    // OMP returns systemPrompt as string[] (breaking change #3); normalize to a string.
    const systemPromptString = Array.isArray(systemPrompt)
      ? systemPrompt.map((part) => (typeof part === "string" ? part : "")).join("\n")
      : typeof systemPrompt === "string"
        ? systemPrompt
        : undefined;

    const rawPromptInput = shapePayload({
      prompt: event.prompt,
      images: event.images,
      context: event.context ?? event.attachments,
    });

    // Subagent attribution: file-backed task/eval lanes are detected from the
    // session file path; in-memory children carry the parent link on their
    // session scope (written by the withSession fence in index.ts).
    let sessionFile: string | undefined;
    try {
      const file = ctx?.sessionManager?.getSessionFile?.();
      if (typeof file === "string" && file) {
        sessionFile = file;
      }
    } catch {
      // Ephemeral mode or throwing host; fall back to the captured path.
    }
    sessionFile ??= state.sessionFilePath;

    let attribution = detectSubagentSession(sessionFile);
    if (!attribution) {
      const inherited = getSessionRunState().inheritedParent;
      if (inherited) {
        // The `inmem:` prefix is the scope key only, never a Langfuse id.
        const strippedScopeId = state.currentSessionId.startsWith(INMEM_SCOPE_PREFIX)
          ? state.currentSessionId.slice(INMEM_SCOPE_PREFIX.length)
          : state.currentSessionId;
        const taskId = getSessionRunState().ownerSessionId || strippedScopeId;
        attribution = {
          taskId,
          ownSessionId: strippedScopeId,
          parentSessionId: inherited.sessionId,
          parentTraceId: inherited.traceId,
          traceName: subagentTraceName(taskId),
        };
      }
    }
    if (attribution?.parentSessionId && !attribution.parentTraceId) {
      attribution.parentTraceId = lookupParentTrace(attribution.parentSessionId);
    }

    const langfuseSessionId = truncate(attribution?.parentSessionId ?? state.currentSessionId, 200) || undefined;
    const traceName = attribution?.traceName ?? "omp-agent";

    const sourceMetadata = collectSourceMetadata(cwd);
    const captured = applyCapturePolicy(
      {
        input: rawPromptInput,
        metadata: {
          cwd,
          ...sourceMetadata,
          ...(state.currentModel ? { model: state.currentModel } : {}),
          ...(state.currentProvider ? { provider: state.currentProvider } : {}),
          ...(attribution
            ? {
                role: "subagent",
                task_id: attribution.taskId,
                sessionId: attribution.ownSessionId,
                ...(attribution.parentSessionId ? { parent_session_id: attribution.parentSessionId } : {}),
                ...(attribution.parentTraceId ? { parent_trace_id: attribution.parentTraceId } : {}),
              }
            : { sessionId: state.currentSessionId || undefined }),
        },
        systemPrompt: systemPromptString ? truncate(systemPromptString, 20000) : undefined,
      },
      getCapturePolicy(),
    );

    state.agentState = {
      cwd,
      promptInput: captured.input,
      generationSeq: 0,
      activeGenerations: new Map(),
      generationOrder: [],
      activeTools: new Map(),
      sourceMetadata,
      providerMetadataByRequest: new Map(),
      pendingAdvisorGenerations: [],
      rolesSeen: new Set(),
      advisorTotals: { generations: 0, costUsd: 0, tokens: 0 },
    };
    if (attribution) {
      // Pre-seed the role so generation.ts appends "default" to the role story
      // instead of replacing it, and store the linkage for the finish update.
      state.agentState.rolesSeen.add("subagent");
      state.agentState.subagent = attribution;
    }
    let ownerSessionId: string | undefined;
    try {
      const id = ctx?.sessionManager?.getSessionId?.();
      if (typeof id === "string" && id) {
        ownerSessionId = id;
      }
    } catch {
      // Treat as absent.
    }
    if (ownerSessionId) {
      state.agentState.ownerSessionId = ownerSessionId;
      getSessionRunState().ownerSessionId = ownerSessionId;
    }

    const root = rt.propagateAttributes(
      {
        sessionId: langfuseSessionId,
        traceName,
        metadata: stringMetadata(captured.metadata),
      },
      () =>
        rt.startObservation(
          traceName,
            {
              input: captured.input,
              metadata: {
                ...(captured.metadata ?? {}),
                ...(captured.systemPrompt ? { systemPrompt: captured.systemPrompt } : {}),
              },
            },
          { asType: "agent" },
        ),
    );

    state.agentState.root = root;
    state.agentState.traceId = root.traceId;
    updateTraceIO(captured.input, undefined);
    // Register this run as the parent for later file-backed subagents in the
    // same Langfuse session. Subagent traces are never registered as parents.
    if (!attribution && state.currentSessionId && root.traceId) {
      rememberParentTrace(state.currentSessionId, root.traceId);
    }
  } catch (e) {
    console.warn("📊 Langfuse: Failed to create agent observation", e);
    state.isTracingDisabled = true;
  }
}

export async function finishAgentRun(event: Record<string, unknown> = {}) {
  if (!state.agentState?.root) {
    resetRunState();
    return;
  }

  const lastAssistant = extractFinalAssistant(event.messages);
  const rawOutput = lastAssistant ? extractAssistantOutput(lastAssistant) : state.agentState.latestAssistantOutput;
  const captured = applyCapturePolicy(
    {
      output: rawOutput,
      metadata: {
        cwd: state.agentState.cwd,
        ...(state.agentState.sourceMetadata ?? {}),
        completed: true,
        model: state.currentModel || undefined,
        provider: state.currentProvider || undefined,
        totalTools: state.toolCallCount,
        ...computeEvaluationScores(),
        // Re-assert subagent fields so the end update cannot drop them.
        ...(state.agentState.subagent
          ? {
              role: "subagent",
              task_id: state.agentState.subagent.taskId,
              sessionId: state.agentState.subagent.ownSessionId,
              ...(state.agentState.subagent.parentSessionId
                ? { parent_session_id: state.agentState.subagent.parentSessionId }
                : {}),
              ...(state.agentState.subagent.parentTraceId
                ? { parent_trace_id: state.agentState.subagent.parentTraceId }
                : {}),
            }
          : {}),
      },
    },
    getCapturePolicy(),
  );
  const scores = computeEvaluationScores();

  closeDanglingObservations("Agent run ended before observation finalized");

  try {
    state.agentState.root
      .update({
        output: captured.output,
        metadata: captured.metadata,
      })
      .end();
    updateTraceIO(state.agentState.promptInput, captured.output);

    await sendScore("tool_call_count", scores.tool_call_count, { traceId: state.agentState.traceId });
    await sendScore("turn_count", scores.turn_count, { traceId: state.agentState.traceId });
    await sendScore("total_tool_errors", scores.total_tool_errors, { traceId: state.agentState.traceId });
    await sendScore("tool_success_rate", scores.tool_success_rate, { traceId: state.agentState.traceId });
    await sendScore("session_had_errors", scores.session_had_errors, { traceId: state.agentState.traceId });

    // Per-role economics: trace-level advisor totals from transcript
    // reconciliation (trace metadata/tags cannot be set after trace creation
    // outside the propagateAttributes closure, so scores are the surface).
    const advisorTotals = state.agentState.advisorTotals;
    if (advisorTotals.generations > 0) {
      await sendScore("advisor_generation_count", advisorTotals.generations, { traceId: state.agentState.traceId });
      await sendScore("advisor_total_tokens", advisorTotals.tokens, { traceId: state.agentState.traceId });
      await sendScore("advisor_cost_usd", Number(advisorTotals.costUsd.toFixed(8)), { traceId: state.agentState.traceId });
    }
  } catch (e) {
    console.warn("📊 Langfuse: Failed to finish agent observation", e);
  } finally {
    resetRunState();
  }
}
