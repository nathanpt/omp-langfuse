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
