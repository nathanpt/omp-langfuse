import assert from "node:assert/strict";
import { test } from "node:test";

import { state } from "../src/state.js";
import type { LangfuseRuntime } from "../src/types.js";
import { flushRuntimeTracers, __setRuntimeForTest } from "../src/langfuse.js";

// getRuntime requires credentials before it hands back the runtime.
state.config = {
  publicKey: "pk-lf-test",
  secretKey: "sk-lf-test",
} as typeof state.config;

function runtimeWith(overrides: Partial<LangfuseRuntime>): LangfuseRuntime {
  return { scoreClient: {}, ...overrides } as LangfuseRuntime;
}

test("flushes both OTel layers", async () => {
  let tracerFlushes = 0;
  let processorFlushes = 0;
  __setRuntimeForTest(
    runtimeWith({
      tracerProvider: {
        forceFlush: async () => {
          tracerFlushes++;
        },
      },
      spanProcessor: {
        forceFlush: async () => {
          processorFlushes++;
        },
      },
    }),
  );

  await flushRuntimeTracers();

  assert.equal(tracerFlushes, 1, "tracer provider flushed");
  assert.equal(processorFlushes, 1, "span processor flushed");
  __setRuntimeForTest(null);
});

test("one failing layer does not starve the other", async () => {
  let processorFlushes = 0;
  __setRuntimeForTest(
    runtimeWith({
      tracerProvider: {
        forceFlush: async () => {
          throw new Error("boom");
        },
      },
      spanProcessor: {
        forceFlush: async () => {
          processorFlushes++;
        },
      },
    }),
  );

  await flushRuntimeTracers();

  assert.equal(processorFlushes, 1, "healthy layer still flushed");
  __setRuntimeForTest(null);
});

test("absent or cleared runtime resolves without throwing", async () => {
  __setRuntimeForTest(null);
  await flushRuntimeTracers();
});
