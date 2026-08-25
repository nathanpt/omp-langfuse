import test from "node:test";
import assert from "node:assert/strict";

import {
  finishGenerationFromMessage,
  startGeneration,
} from "../src/handlers/generation.ts";
import {
  clearAllSessionStates,
  setCurrentSession,
  state,
} from "../src/state.ts";
import type { AgentState, LangfuseObservation, ObservationUpdate } from "../src/types.js";

class FakeObservation implements LangfuseObservation {
  id = "fake-observation";
  traceId = "fake-trace";
  updates: Array<ObservationUpdate | undefined> = [];
  children: FakeObservation[] = [];
  ended = false;
  name?: string;

  constructor(public body?: ObservationUpdate) {}

  update(body?: ObservationUpdate): LangfuseObservation {
    this.updates.push(body);
    return this;
  }

  end(body?: ObservationUpdate): void {
    if (body) {
      this.updates.push(body);
    }
    this.ended = true;
  }

  startObservation(_name: string, body?: ObservationUpdate): LangfuseObservation {
    const child = new FakeObservation(body);
    child.name = _name;
    this.children.push(child);
    return child;
  }
}

function makeAgentState(root: LangfuseObservation): AgentState {
  return {
    root,
    generationSeq: 0,
    activeGenerations: new Map(),
    generationOrder: [],
    activeTools: new Map(),
    providerMetadataByRequest: new Map(),
    pendingAdvisorGenerations: [],
    rolesSeen: new Set(),
    advisorTotals: { generations: 0, costUsd: 0, tokens: 0 },
  };
}

test("startGeneration includes modelParameters extracted from provider payload", async () => {
  clearAllSessionStates();
  setCurrentSession("generation-test");

  const root = new FakeObservation();
  state.agentState = makeAgentState(root);

  await startGeneration({
    requestId: "request-1",
    payload: {
      model: "gpt-test",
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 1024,
      stop: ["\n"],
    },
  });

  assert.equal(root.children.length, 1);
  assert.deepEqual(root.children[0]?.body?.modelParameters, {
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 1024,
  });
});

test("finishGenerationFromMessage preserves modelParameters on update from event payload", async () => {
  clearAllSessionStates();
  setCurrentSession("generation-test");

  const root = new FakeObservation();
  state.agentState = makeAgentState(root);

  await startGeneration({
    requestId: "request-1",
    payload: {
      temperature: 0.3,
      reasoning_effort: "high",
    },
  });

  await finishGenerationFromMessage({
    message: {
      role: "assistant",
      content: "done",
    },
    payload: {
      temperature: 0.3,
      reasoning_effort: "high",
    },
  });

  const child = root.children[0];
  assert.deepEqual(child?.updates.at(-1)?.modelParameters, {
    temperature: 0.3,
    reasoning_effort: "high",
  });
  assert.equal(child?.ended, true);
});


test("startGeneration tags advisor generations from the advise tool marker", async () => {
  clearAllSessionStates();
  setCurrentSession("generation-test");

  const root = new FakeObservation();
  state.agentState = makeAgentState(root);
  state.currentModel = "claude-sonnet-4";

  await startGeneration({
    requestId: "advisor-1",
    payload: {
      model: "glm-5.2",
      tools: [{ name: "advise" }, { name: "bash" }],
    },
  });

  assert.equal(root.children.length, 1);
  const child = root.children[0] as FakeObservation;
  assert.equal(child.name, "llm-generation:advisor");
  assert.equal(child.body?.metadata?.role, "advisor");
  // The payload model wins over the primary's currentModel.
  assert.equal(child.body?.model, "glm-5.2");
  assert.deepEqual(state.agentState?.pendingAdvisorGenerations, ["advisor-1"]);
  assert.equal(state.agentState?.rolesSeen.has("advisor"), true);
});

test("primary message_end does not close an in-flight advisor generation", async () => {
  clearAllSessionStates();
  setCurrentSession("generation-test");

  const root = new FakeObservation();
  state.agentState = makeAgentState(root);

  await startGeneration({
    requestId: "advisor-1",
    payload: { tools: [{ name: "advise" }] },
  });
  await startGeneration({
    requestId: "primary-1",
    payload: { tools: [{ name: "bash" }] },
  });

  await finishGenerationFromMessage({
    message: { role: "assistant", content: "done", model: "glm-5.2", usage: { input: 10, output: 5 } },
  });

  assert.equal(state.agentState?.activeGenerations.get("advisor-1")?.ended, false);
  assert.equal(state.agentState?.activeGenerations.get("primary-1")?.ended, true);
  assert.deepEqual(state.agentState?.pendingAdvisorGenerations, ["advisor-1"]);
});

test("registry rate applies only when the generation model matches the primary's", async () => {
  clearAllSessionStates();
  setCurrentSession("generation-test");

  const root = new FakeObservation();
  state.agentState = makeAgentState(root);
  // A model absent from the bundled tables, so the catalog rate is the only
  // possible registry-priced path (bundled entries shadow it).
  state.currentModel = "catalog-only-model";
  state.currentModelCost = { input: 99, output: 99 };

  await startGeneration({ requestId: "request-1", payload: { tools: [{ name: "bash" }] } });
  await finishGenerationFromMessage({
    message: { role: "assistant", content: "x", model: "claude-sonnet-4", usage: { input: 100, output: 20 } },
  });

  // Different model: the bundled claude table prices it, not the leaked 99/99 catalog rate.
  const foreign = root.children[0]?.updates.at(-1)?.costDetails;
  assert.ok(foreign);
  assert.ok(Math.abs((foreign?.total ?? 0) - (100 * 3 + 20 * 15) / 1e6) < 1e-9);

  // Same model: the catalog registry rate applies.
  await startGeneration({ requestId: "request-2", payload: { tools: [{ name: "bash" }] } });
  await finishGenerationFromMessage({
    message: { role: "assistant", content: "y", model: "catalog-only-model", usage: { input: 100, output: 20 } },
  });
  const registry = root.children[1]?.updates.at(-1)?.costDetails;
  assert.ok(registry);
  assert.ok(Math.abs((registry?.total ?? 0) - (100 * 99 + 20 * 99) / 1e6) < 1e-9);
});

test("registry rate does not leak onto an unknown advisor model", async () => {
  clearAllSessionStates();
  setCurrentSession("generation-test");

  const root = new FakeObservation();
  state.agentState = makeAgentState(root);
  state.currentModel = "glm-5.2";
  state.currentModelCost = { input: 99, output: 99 };

  await startGeneration({ requestId: "request-1", payload: { tools: [{ name: "bash" }] } });
  await finishGenerationFromMessage({
    message: { role: "assistant", content: "x", model: "totally-unknown-model", usage: { input: 100, output: 20 } },
  });

  // Unmatched model: no bundled price and no registry leak — cost stays unset
  // (the warnOnceNoPrice correction path) instead of mispricing.
  assert.equal(root.children[0]?.updates.at(-1)?.costDetails, undefined);
});