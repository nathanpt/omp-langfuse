import type { CapturePolicy } from "./capture-policy.js";
import type { PriceOverride } from "./pricing.js";
import type { GenerationRole } from "./role.js";

export interface Config {
  publicKey: string;
  secretKey: string;
  host: string;
  capturePolicy?: CapturePolicy;
  /** Per-model per-token price overrides (USD per 1M tokens). Keyed by model id. */
  pricing?: Record<string, PriceOverride>;
}

export interface LangfuseObservation {
  id?: string;
  traceId?: string;
  update(body?: ObservationUpdate): LangfuseObservation;
  end(body?: ObservationUpdate): void;
  startObservation?(
    name: string,
    body?: ObservationUpdate,
    options?: { asType?: "agent" | "generation" | "tool" | "span" },
  ): LangfuseObservation;
  setTraceIO?(body?: { input?: unknown; output?: unknown }): void;
}

export interface ObservationUpdate {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  model?: string;
  modelParameters?: Record<string, string | number>;
  usageDetails?: Record<string, number>;
  usage?: Record<string, number>;
  costDetails?: Record<string, number>;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  completionStartTime?: Date;
}

export interface LangfuseScoreClient {
  api?: {
    trace?: {
      get?: (traceId: string) => Promise<unknown>;
    };
    ingestion?: {
      batch?: (request: unknown) => Promise<unknown>;
    };
  };
  score?: {
    create(body: {
      traceId?: string;
      sessionId?: string;
      observationId?: string;
      name: string;
      value: number;
      dataType?: "NUMERIC" | "BOOLEAN";
    }): unknown;
  };
  flush?: () => Promise<void>;
  shutdown?: () => Promise<void>;
}

export interface LangfuseRuntime {
  startObservation: (
    name: string,
    body?: ObservationUpdate,
    options?: { asType?: "agent" | "generation" | "tool" | "span" },
  ) => LangfuseObservation;
  propagateAttributes: (
    params: {
      sessionId?: string;
      traceName?: string;
      metadata?: Record<string, string>;
      tags?: string[];
    },
    fn: () => LangfuseObservation,
  ) => LangfuseObservation;
  scoreClient: LangfuseScoreClient;
  spanProcessor?: { forceFlush?: () => Promise<void>; shutdown?: () => Promise<void> };
  tracerProvider?: { forceFlush?: () => Promise<void>; shutdown?: () => Promise<void> };
  clearTracerProvider?: () => void;
  restFallback?: unknown;
}

export interface GenerationState {
  observation: LangfuseObservation;
  requestKey: string;
  ended: boolean;
  /** Requesting role (primary agent vs advisor), inferred at start. */
  role: GenerationRole;
  /** True per-request model from the provider payload (may differ from the primary's). */
  model?: string;
  metadata: Record<string, unknown>;
  modelParameters?: Record<string, string | number>;
  ttftRecorded?: boolean;
}

export interface ToolState {
  observation: LangfuseObservation;
  toolName: string;
  ended: boolean;
  startedAt: number;
  inputBytes: number;
}

export interface AgentState {
  root?: LangfuseObservation;
  activeTurn?: LangfuseObservation;
  traceId?: string;
  /** Set when this run was attributed to a task/eval subagent; drives trace name, session grouping, metadata. */
  subagent?: {
    taskId: string;
    ownSessionId: string;
    parentSessionId?: string;
    parentTraceId?: string;
    traceName: string;
  };
  promptInput?: unknown;
  cwd?: string;
  generationSeq: number;
  activeGenerations: Map<string, GenerationState>;
  generationOrder: string[];
  activeTools: Map<string, ToolState>;
  latestAssistantOutput?: unknown;
  sourceMetadata?: Record<string, unknown>;
  providerMetadataByRequest: Map<string, Record<string, unknown>>;
  /** Request keys of open advisor generations, FIFO — pairing queue for transcript reconciliation. */
  pendingAdvisorGenerations: string[];
  /** Roles observed in this run; the root trace metadata is patched when a new one appears. */
  rolesSeen: Set<string>;
  /** Run-scoped advisor totals, flushed as trace-level `advisor_*` scores at agent_end. */
  advisorTotals: { generations: number; costUsd: number; tokens: number };
}
