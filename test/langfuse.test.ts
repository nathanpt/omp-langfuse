import test from "node:test";
import assert from "node:assert/strict";

import { __setRuntimeForTest, ensureOtelContextManager, forceShutdownRuntime } from "../src/langfuse.ts";
import type { LangfuseRuntime } from "../src/types.js";

import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import * as tracing from "@langfuse/tracing";
import { context } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";

function never(): Promise<void> {
  return new Promise(() => {});
}

test("registers OTel context propagation for Langfuse trace attributes", async () => {
  const disabledManagers: string[] = [];
  let fakeSetCalls = 0;
  const fakeContextApi = {
    setGlobalContextManager(_manager: { enable(): unknown; disable(): void }) {
      fakeSetCalls += 1;
      return false;
    },
  };
  class FakeAsyncHooksContextManager {
    enable() {
      return this;
    }
    disable() {
      disabledManagers.push("candidate");
    }
  }

  assert.equal(ensureOtelContextManager(fakeContextApi, FakeAsyncHooksContextManager), false);
  assert.equal(ensureOtelContextManager(fakeContextApi, FakeAsyncHooksContextManager), false);
  assert.equal(fakeSetCalls, 2);
  assert.deepEqual(disabledManagers, ["candidate", "candidate"]);

  ensureOtelContextManager(context, AsyncHooksContextManager);
  const callsAfterRegistration = fakeSetCalls;
  assert.equal(ensureOtelContextManager(fakeContextApi, FakeAsyncHooksContextManager), true);
  assert.equal(fakeSetCalls, callsAfterRegistration);

  const exportedSpans: Array<{ attributes: Record<string, unknown> }> = [];
  const exporter = {
    export(spans: Array<{ attributes: Record<string, unknown> }>, callback: (result: { code: number }) => void) {
      exportedSpans.push(...spans);
      callback({ code: 0 });
    },
    shutdown: async () => {},
    forceFlush: async () => {},
  };
  const spanProcessor = new LangfuseSpanProcessor({
    publicKey: "pk_test",
    secretKey: "sk_test",
    baseUrl: "http://localhost",
    exporter,
  });
  const tracerProvider = new BasicTracerProvider({ spanProcessors: [spanProcessor] });
  const previousProvider = tracing.getLangfuseTracerProvider();

  try {
    tracing.setLangfuseTracerProvider(tracerProvider);
    tracing.propagateAttributes({ sessionId: "test-session", traceName: "pi-agent" }, () => {
      const observation = tracing.startObservation("pi-agent", { input: "hello" }, { asType: "agent" });
      observation.end();
    });
    await tracerProvider.forceFlush();

    assert.equal(exportedSpans.length, 1);
    assert.equal(exportedSpans[0].attributes["session.id"], "test-session");
    assert.equal(exportedSpans[0].attributes["langfuse.trace.name"], "pi-agent");
    assert.equal(exportedSpans[0].attributes["langfuse.observation.type"], "agent");
  } finally {
    tracing.setLangfuseTracerProvider(previousProvider);
    await tracerProvider.shutdown();
  }
});

test("force shutdown does not hang when Langfuse SDK shutdown stalls", async () => {
  const runtime = {
    startObservation: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["startObservation"],
    propagateAttributes: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["propagateAttributes"],
    scoreClient: {
      flush: never,
      shutdown: never,
    },
    tracerProvider: {
      forceFlush: never,
      shutdown: never,
    },
    clearTracerProvider: () => {},
  } satisfies LangfuseRuntime;

  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = () => {};

  try {
    __setRuntimeForTest(runtime, 50);

    const result = await Promise.race([
      forceShutdownRuntime().then(() => "resolved"),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
    ]);

    assert.equal(result, "resolved");
  } finally {
    __setRuntimeForTest(null);
    console.warn = originalWarn;
    console.log = originalLog;
  }
});

test("REST fallback calls Langfuse ingestion with its SDK receiver", async () => {
  const ingestion = {
    called: false,
    async batch(this: { called: boolean }, _request: unknown) {
      this.called = true;
      return {};
    },
  };
  const runtime = {
    startObservation: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["startObservation"],
    propagateAttributes: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["propagateAttributes"],
    scoreClient: {
      api: {
        trace: {
          get: async () => undefined,
        },
        ingestion,
      },
    },
    restFallback: {
      trace: {
        id: "trace-uses-bound-batch",
        timestamp: new Date().toISOString(),
        name: "pi-agent",
      },
      observations: [],
      observationById: new Map(),
      attempted: false,
    },
  } satisfies LangfuseRuntime;

  const logs: unknown[][] = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };

  try {
    __setRuntimeForTest(runtime, 50);

    await forceShutdownRuntime();

    assert.equal(ingestion.called, true);
    assert.deepEqual(logs, []);
  } finally {
    __setRuntimeForTest(null);
    console.warn = originalWarn;
    console.log = originalLog;
  }
});
