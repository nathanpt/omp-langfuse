/**
 * Process-global registry of open parent traces: Langfuse session id → trace id.
 *
 * Subagents run in-process (task/executor.ts) but in a different
 * AsyncLocalStorage session scope, so the mapping cannot live on session
 * state — a plain module-level Map is the only channel that survives the
 * scope switch. File-backed subagents read their `parent_trace_id` here.
 */

const parentTraceBySession = new Map<string, string>();

export function rememberParentTrace(sessionId: string, traceId: string): void {
  if (!sessionId || !traceId) {
    return;
  }
  // Later parent run in the same session overwrites: children should link to
  // the latest open/last run.
  parentTraceBySession.set(sessionId, traceId);
}

export function lookupParentTrace(sessionId: string): string | undefined {
  return parentTraceBySession.get(sessionId);
}

export function clearParentTraceRegistry(): void {
  parentTraceBySession.clear();
}
