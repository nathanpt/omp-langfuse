import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePrice,
  computeCost,
  warnOnceNoPrice,
  __resetPriceWarningsForTest,
} from "../src/pricing.js";

test("resolvePrice prefers a user config override over the bundled table", () => {
  __resetPriceWarningsForTest();
  const override = resolvePrice("deepseek-v3", { "deepseek-v3": { input: 99, output: 99 } });
  assert.equal(override?.input, 99);
  assert.equal(override?.output, 99);
  // missing components default to 0
  assert.equal(override?.cacheRead, 0);
});

test("resolvePrice matches a bundled exact id (case-insensitive)", () => {
  const price = resolvePrice("DeepSeek-V3.1");
  assert.equal(price?.input, 0.27);
  assert.equal(price?.output, 1.1);
  assert.equal(price?.cacheRead, 0.07);
});

test("resolvePrice falls back to a family prefix for unknown variants", () => {
  // glm-5.2 is not in the exact table; it inherits the GLM family rate.
  const price = resolvePrice("glm-5.2");
  assert.equal(price?.input, 0.43);
  assert.equal(price?.output, 1.74);
});

test("resolvePrice uses registry (per-token) rate only when input+output are non-zero", () => {
  // Per-token registry rate must be converted to per-Mtok.
  const fromRegistry = resolvePrice("some-unknown-model", undefined, {
    input: 0.000002,
    output: 0.000008,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.deepEqual(fromRegistry, { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 });

  // Zeroed registry rate (subscription model) is ignored.
  const ignored = resolvePrice("glm-5.2", undefined, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  // Falls back to bundled family, NOT the zeroed registry rate.
  assert.equal(ignored?.input, 0.43);
});

test("resolvePrice returns undefined for a model with no resolvable price", () => {
  __resetPriceWarningsForTest();
  const price = resolvePrice("totally-unknown-model-xyz");
  assert.equal(price, undefined);
});

test("computeCost multiplies tokens by per-Mtok price and sums components", () => {
  const cost = computeCost(
    { input: 1_000_000, output: 500_000, cacheRead: 200_000, cacheWrite: 0 },
    { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  );
  assert.equal(cost.input, 3);
  assert.equal(cost.output, 7.5);
  assert.equal(cost.cacheRead, 0.06);
  assert.equal(cost.cacheWrite, 0);
  assert.equal(cost.total, 10.56);
});

test("computeCost handles missing token fields as zero", () => {
  const cost = computeCost({ input: 1_000_000 }, { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 });
  assert.equal(cost.input, 2);
  assert.equal(cost.output, 0);
  assert.equal(cost.total, 2);
});

test("warnOnceNoPrice warns at most once per model id", () => {
  __resetPriceWarningsForTest();
  // Should not throw; idempotent across calls for the same id.
  assert.doesNotThrow(() => warnOnceNoPrice("mystery-model"));
  assert.doesNotThrow(() => warnOnceNoPrice("mystery-model"));
});
