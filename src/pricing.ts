/**
 * Self-sourced per-token pricing + cost computation (design §8.1, breaking change #7).
 *
 * OMP's host-reported `message.usage.cost` is computed from the model registry's
 * rates, which are zeroed for subscription / free-tier models (e.g. glm-5.2 returns
 * `cost.total = 0`). We therefore NEVER trust host cost: cost is always recomputed
 * from the populated token counts (`usage.{input,output,cacheRead,cacheWrite}`)
 * times a resolved per-token price.
 *
 * Price resolution (first match wins), per message model id:
 *   1. user config override (exact id)        — state.config.pricing
 *   2. bundled table (exact id)
 *   3. bundled table (longest family prefix)  — e.g. "glm-5.2" -> "glm"
 *   4. registry rate (ctx.model.cost)         — catalog entry, already $/Mtok;
 *                                              only when input+output non-zero
 *   5. none -> omit cost, warn once per model
 *
 * The bundled table covers only models the host registry zeroes (subscription /
 * free-tier, e.g. Zhipu GLM-5.x) where external rates must be sourced by hand.
 * All paid models are priced accurately via step 4 from the OMP model catalog
 * (@oh-my-pi/pi-catalog), whose `cost` fields are documented as $/million tokens.
 *
 * Rates are USD per 1_000_000 tokens (how providers publish them); divided by
 * PRICE_PER_MILLION at compute time.
 */

import { PRICE_PER_MILLION } from "./constants.js";

export interface TokenPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read (cached input) tokens. */
  cacheRead: number;
  /** USD per 1M cache-write tokens. */
  cacheWrite: number;
}

/** A partial price entry (any missing component is treated as 0). */
export type PriceOverride = Partial<TokenPrice>;

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Bundled starter price table. USD per 1M tokens.
 *
 * `_flag` entries are family-prefix matches (longest prefix wins). `cacheWrite` is
 * populated only where the provider publishes it (Anthropic); others use 0.
 *
 * Prices sourced from provider listings dated 2026-07. Model pricing drifts — the
 * one-time "no price for model" warning + per-model config overrides are the
 * intended correction path (design §8.1).
 */
const BUNDLED_EXACT: Record<string, TokenPrice> = {
  // DeepSeek (official API)
  "deepseek-v3": f(0.27, 1.1, 0.07),
  "deepseek-v3.1": f(0.27, 1.1, 0.07),
  "deepseek-chat": f(0.27, 1.1, 0.07),
  "deepseek-r1": f(0.55, 2.19, 0.14),
  "deepseek-reasoner": f(0.55, 2.19, 0.14),
  // Zhipu GLM-4.6 (sourced from Deep Infra / OpenRouter listings)
  "glm-4.6": f(0.43, 1.74, 0.08),
  "glm-4-32b": f(0.43, 1.74, 0.08),
  // Zhipu GLM-5.x (catalog zeroes these as subscription models; API rates
  // sourced from Z.ai / bigmodel.cn listings, corroborated by the catalog's own
  // coreweave GLM-5.1 entry). cacheWrite is not published for GLM (0).
  "glm-5": f(1.4, 4.4, 0.26),
  "glm-5.1": f(1.4, 4.4, 0.26),
  "glm-5.2": f(1.4, 4.4, 0.26),
  // Anthropic Claude
  "claude-sonnet-4": f(3, 15, 0.3, 3.75),
  "claude-3-5-sonnet": f(3, 15, 0.3, 3.75),
  "claude-3-7-sonnet": f(3, 15, 0.3, 3.75),
  "claude-haiku-4": f(1, 5, 0.1, 1.25),
  "claude-3-5-haiku": f(1, 5, 0.1, 1.25),
  "claude-opus-4": f(15, 75, 1.5, 18.75),
  "claude-3-opus": f(15, 75, 1.5, 18.75),
  // OpenAI
  "gpt-4.1": f(2, 8, 0.5),
  "gpt-4.1-mini": f(0.4, 1.6, 0.1),
  "gpt-4.1-nano": f(0.1, 0.4, 0.025),
  "gpt-4o": f(2.5, 10, 1.25),
  "gpt-4o-mini": f(0.15, 0.6, 0.075),
  "o3-mini": f(1.1, 4.4, 0.55),
  "o4-mini": f(1.1, 4.4, 0.55),
};

/**
 * Family-prefix entries, checked longest-first after exact matches fail.
 * Used as *estimates* — override in config for accuracy.
 */
const BUNDLED_FAMILY: Array<{ prefix: string; price: TokenPrice }> = [
  // GLM-5.x family rate (current generation; GLM-4.6 has its own exact entry above).
  { prefix: "glm", price: f(1.4, 4.4, 0.26) },
  { prefix: "deepseek", price: f(0.27, 1.1, 0.07) },
  { prefix: "claude-sonnet", price: f(3, 15, 0.3, 3.75) },
  { prefix: "claude-haiku", price: f(1, 5, 0.1, 1.25) },
  { prefix: "claude-opus", price: f(15, 75, 1.5, 18.75) },
];

/** Construct a full TokenPrice from partial components (missing => 0). */
function f(input: number, output: number, cacheRead = 0, cacheWrite = 0): TokenPrice {
  return { input, output, cacheRead, cacheWrite };
}

/** gpt-5.x: deliberately unset (pricing uncertain). Listed for visibility only. */
export const UNSET_MODELS = ["gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.5"];

const warnedNoPrice = new Set<string>();

function normalizeModelId(modelId: string): string {
  return (modelId || "").trim().toLowerCase();
}

/**
 * Resolve a per-token price for the given model id.
 *
 * @param modelId runtime model id (e.g. "glm-5.2")
 * @param overrides user config pricing map (exact id match, case-insensitive)
 * @param registryRate optional host `ctx.model.cost` (used only if all four fields non-zero)
 */
export function resolvePrice(
  modelId: string,
  overrides?: Record<string, PriceOverride>,
  registryRate?: PriceOverride,
): TokenPrice | undefined {
  const id = normalizeModelId(modelId);
  if (!id) {
    return undefined;
  }

  // 1. user config override (exact)
  const override = overrides && pickOverride(overrides, id);
  if (override) {
    return f(override.input ?? 0, override.output ?? 0, override.cacheRead ?? 0, override.cacheWrite ?? 0);
  }

  // 2. bundled exact
  const exact = BUNDLED_EXACT[id];
  if (exact) {
    return exact;
  }

  // 3. bundled family prefix (longest match first)
  const familyMatch = BUNDLED_FAMILY
    .filter((entry) => id.startsWith(entry.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (familyMatch) {
    return familyMatch.price;
  }

  // 4. registry rate (ctx.model.cost is the OMP catalog entry, already $/Mtok —
  //    per the @oh-my-pi/pi-catalog Model.cost type def). Use it directly; no
  //    unit conversion. Only when input+output are non-zero (subscription / free
  //    models are zeroed in the catalog and must be priced via the table above).
  if (
    registryRate &&
    (registryRate.input ?? 0) > 0 &&
    (registryRate.output ?? 0) > 0
  ) {
    return f(
      registryRate.input ?? 0,
      registryRate.output ?? 0,
      registryRate.cacheRead ?? 0,
      registryRate.cacheWrite ?? 0,
    );
  }

  return undefined;
}

function pickOverride(overrides: Record<string, PriceOverride>, id: string): PriceOverride | undefined {
  for (const [key, value] of Object.entries(overrides)) {
    if (normalizeModelId(key) === id) {
      return value;
    }
  }
  return undefined;
}

/**
 * Compute USD cost from token usage and a resolved price.
 * Missing token fields are treated as 0. cacheRead/cacheWrite are included.
 */
export function computeCost(usage: UsageTokens, price: TokenPrice): CostBreakdown {
  const input = Math.max(0, Number(usage.input ?? 0));
  const output = Math.max(0, Number(usage.output ?? 0));
  const cacheRead = Math.max(0, Number(usage.cacheRead ?? 0));
  const cacheWrite = Math.max(0, Number(usage.cacheWrite ?? 0));

  const inputCost = (input * price.input) / PRICE_PER_MILLION;
  const outputCost = (output * price.output) / PRICE_PER_MILLION;
  const cacheReadCost = (cacheRead * price.cacheRead) / PRICE_PER_MILLION;
  const cacheWriteCost = (cacheWrite * price.cacheWrite) / PRICE_PER_MILLION;

  return {
    input: round(inputCost),
    output: round(outputCost),
    cacheRead: round(cacheReadCost),
    cacheWrite: round(cacheWriteCost),
    total: round(inputCost + outputCost + cacheReadCost + cacheWriteCost),
  };
}

function round(value: number): number {
  // 8 decimal places is well below any meaningful token-cost granularity.
  return Math.round(value * 1e8) / 1e8;
}

/** Emit a one-time warning when a model has no resolvable price. Idempotent per model id. */
export function warnOnceNoPrice(modelId: string): void {
  const id = normalizeModelId(modelId);
  if (!id || warnedNoPrice.has(id)) {
    return;
  }
  warnedNoPrice.add(id);
  console.warn(
    `📊 Langfuse: no bundled price for model "${modelId}"; cost omitted. Add an override in ~/.omp/agent/omp-langfuse/config.json under "pricing" (see design §7.4).`,
  );
}

/** Reset the warned-models set (test helper). */
export function __resetPriceWarningsForTest(): void {
  warnedNoPrice.clear();
}
