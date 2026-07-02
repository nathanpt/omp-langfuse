import test from "node:test";
import assert from "node:assert/strict";

import { startChildObservation } from "../src/observation.ts";
import type { LangfuseObservation, LangfuseRuntime, ObservationUpdate } from "../src/types.js";

function makeObservation(id: string): LangfuseObservation & { children: string[] } {
  return {
    id,
    children: [],
    update() {
      return this;
    },
    end() {},
    startObservation(name: string) {
      this.children.push(name);
      return makeObservation(`${id}.${name}`);
    },
  };
}

function makeRuntime(calls: string[]): LangfuseRuntime {
  return {
    startObservation(name: string) {
      calls.push(name);
      return makeObservation(`runtime.${name}`);
    },
    propagateAttributes(_params, fn) {
      return fn();
    },
    scoreClient: {},
  };
}

test("startChildObservation prefers parent startObservation when available", async () => {
  const parent = makeObservation("parent");
  const runtimeCalls: string[] = [];

  const child = await startChildObservation({
    parent,
    runtime: async () => makeRuntime(runtimeCalls),
    name: "tool",
    body: { metadata: { toolCallId: "call-1" } },
    asType: "tool",
  });

  assert.equal(child.id, "parent.tool");
  assert.deepEqual(parent.children, ["tool"]);
  assert.deepEqual(runtimeCalls, []);
});

test("startChildObservation falls back to runtime when parent cannot start children", async () => {
  const parent: LangfuseObservation = {
    id: "parent",
    update() {
      return this;
    },
    end() {},
  };
  const runtimeCalls: string[] = [];
  const body: ObservationUpdate = { metadata: { requestId: "req-1" } };

  const child = await startChildObservation({
    parent,
    runtime: async () => makeRuntime(runtimeCalls),
    name: "llm-generation",
    body,
    asType: "generation",
  });

  assert.equal(child.id, "runtime.llm-generation");
  assert.deepEqual(runtimeCalls, ["llm-generation"]);
});
