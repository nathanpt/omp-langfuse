import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export interface SubagentAttribution {
  taskId: string;
  ownSessionId: string;
  parentSessionId?: string;
  parentTraceId?: string;
  traceName: string;
}

export interface ActiveRunSnapshot {
  ownerSessionId?: string;
  traceId?: string;
  /** `state.currentSessionId` (empty string when the default scope). */
  langfuseSessionId: string;
  hasOpenRoot: boolean;
}

export interface SessionScopeDecision {
  /** When set, `runWithSession` must use this id. When omitted, keep today's fallback (`state.currentSessionId`). */
  scopeId?: string;
  /** Set only for the no-file collision. Caller writes this onto the child scope before the handler runs. */
  inheritedParent?: { sessionId?: string; traceId?: string };
}

/** Capped to defend against pathological layouts (mirrors OMP session-manager). */
const INTERACTIVE_ROOT_WALK_DEPTH = 8;

/** OMP temp artifact dirs: task/index.ts `omp-task-<Snowflake>`, eval/agent-bridge.ts `omp-eval-agent-<Snowflake>`. */
const TEMP_ARTIFACT_DIR = /^(omp-task-|omp-eval-agent-)/;

export function subagentTraceName(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  // All-underscore (incl. empty) means no usable identity — e.g. "***".
  return `omp-agent:${/^_*$/.test(safe) ? "subagent" : safe}`;
}

export function detectSubagentSession(sessionFile: string | undefined): SubagentAttribution | undefined {
  if (!sessionFile) {
    return undefined;
  }

  const resolved = resolve(sessionFile);
  const taskId = basename(resolved, ".jsonl");

  // 1. Nested artifacts (interactive parent): walk up while the containing dir
  //    is itself a session's artifacts dir (`<dir>.jsonl` exists). Same walk as
  //    OMP resolveBreadcrumbToInteractiveRoot, so the trace groups under the
  //    interactive root — not an intermediate lane.
  let current = resolved;
  let moved = false;
  for (let depth = 0; depth < INTERACTIVE_ROOT_WALK_DEPTH; depth++) {
    const parentSessionFile = `${dirname(current)}.jsonl`;
    if (!existsSync(parentSessionFile)) {
      break;
    }
    current = parentSessionFile;
    moved = true;
  }
  if (moved) {
    return {
      taskId,
      ownSessionId: taskId,
      parentSessionId: basename(current, ".jsonl"),
      // parentTraceId is filled from the registry by the caller.
      traceName: subagentTraceName(taskId),
    };
  }

  // 2. Temp artifacts (parent has no session file): task/eval agents run
  //    without a file-backed parent session. Other temp prefixes are not
  //    subagents — do not broaden.
  if (TEMP_ARTIFACT_DIR.test(basename(dirname(resolved)))) {
    return {
      taskId,
      ownSessionId: taskId,
      traceName: subagentTraceName(taskId),
    };
  }

  // 3. Primary session file.
  return undefined;
}

export function resolveSessionScope(input: {
  sessionFile?: string;
  rawSessionId?: string;
  active: ActiveRunSnapshot;
}): SessionScopeDecision {
  if (input.sessionFile) {
    // File-backed linkage is the parent-trace registry, not the scope fence.
    return { scopeId: basename(input.sessionFile, ".jsonl") };
  }

  // No session file: split into a child scope only when a DIFFERENT session
  // collides with an open parent run. The --no-session primary must not be
  // split off the default scope: its first events arrive before an owner is
  // known, later events share the owner's id.
  if (
    input.rawSessionId &&
    input.active.ownerSessionId &&
    input.rawSessionId !== input.active.ownerSessionId &&
    input.active.hasOpenRoot
  ) {
    return {
      scopeId: `inmem:${input.rawSessionId}`,
      inheritedParent: {
        sessionId: input.active.langfuseSessionId || undefined,
        traceId: input.active.traceId,
      },
    };
  }

  return {};
}
