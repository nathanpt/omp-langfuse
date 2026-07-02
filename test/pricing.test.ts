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

test("resolvePrice matches GLM-5.x with the real Zhipu API rate", () => {
  // GLM-5.x is zeroed in the catalog (subscription); the bundled exact entry
  // carries the researched Z.ai API rate ($1.40 / $4.40 / $0.26 per Mtok).
  const price = resolvePrice("glm-5.2");
  assert.equal(price?.input, 1.4);
  assert.equal(price?.output, 4.4);
  assert.equal(price?.cacheRead, 0.26);
});

test("resolvePrice keeps the distinct GLM-4.6 rate for that generation", () => {
  const price = resolvePrice("glm-4.6");
  assert.equal(price?.input, 0.43);
  assert.equal(price?.output, 1.74);
  assert.equal(price?.cacheRead, 0.08);
});

test("resolvePrice uses the registry (catalog) rate directly — it is already $/Mtok", () => {
  // ctx.model.cost comes from @oh-my-pi/pi-catalog, whose Model.cost is
  // documented as $/million tokens. It must NOT be re-converted.
  const fromRegistry = resolvePrice("some-unknown-paid-model", undefined, {
    input: 2,
    output: 8,
    cacheRead: 0.5,
    cacheWrite: 0,
  });
  assert.deepEqual(fromRegistry, { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 });

  // Zeroed registry rate (subscription model) is ignored, falling through to
  // the bundled table.
  const ignored = resolvePrice("glm-5.2", undefined, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(ignored?.input, 1.4);
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
