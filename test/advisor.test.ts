import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reconcileAdvisorUsage } from "../src/handlers/advisor.ts";
import { clearAllSessionStates, setCurrentSession, state } from "../src/state.ts";
import type { AgentState, GenerationState, LangfuseObservation, ObservationUpdate } from "../src/types.ts";

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

function makeAdvisorGeneration(key: string): GenerationState {
  return {
    observation: new FakeObservation(),
    requestKey: key,
    ended: false,
    role: "advisor",
    metadata: {},
  };
}

function makeAgentState(pending: string[], generations: GenerationState[]): AgentState {
  const agentState: AgentState = {
    root: new FakeObservation(),
    generationSeq: 0,
    activeGenerations: new Map(),
    generationOrder: [],
    activeTools: new Map(),
    providerMetadataByRequest: new Map(),
    pendingAdvisorGenerations: [...pending],
    rolesSeen: new Set(),
    advisorTotals: { generations: 0, costUsd: 0, tokens: 0 },
  };
  for (const gen of generations) {
    agentState.activeGenerations.set(gen.requestKey, gen);
    agentState.generationOrder.push(gen.requestKey);
  }
  return agentState;
}

async function makeTranscriptDir(fileName = "__advisor.jsonl") {
  const tmp = await mkdtemp(join(tmpdir(), "advisor-test-"));
  const sessionFile = join(tmp, "sess.jsonl");
  await writeFile(sessionFile, "");
  await mkdir(join(tmp, "sess"));
  return { sessionFile, transcriptFile: join(tmp, "sess", fileName) };
}

function assistantRecord(model = "glm-5.2", input = 100, output = 20): string {
  return JSON.stringify({ role: "assistant", model, usage: { input, output } });
}

test("reconcileAdvisorUsage closes pending advisor generations from transcript records", async () => {
  clearAllSessionStates();
  setCurrentSession("advisor-reconcile");
  const { sessionFile, transcriptFile } = await makeTranscriptDir();
  await writeFile(transcriptFile, `${assistantRecord()}\n${assistantRecord()}\n`);
  state.sessionFilePath = sessionFile;

  const gen1 = makeAdvisorGeneration("adv-1");
  const gen2 = makeAdvisorGeneration("adv-2");
  const agentState = makeAgentState(["adv-1", "adv-2"], [gen1, gen2]);
  state.agentState = agentState;

  await reconcileAdvisorUsage();

  for (const gen of [gen1, gen2]) {
    const update = gen.observation.updates.at(-1);
    assert.deepEqual(update?.usageDetails, { input: 100, output: 20, total: 120 });
    // GLM-5 bundled rate: 1.4 / 4.4 per Mtok.
    assert.ok(Math.abs((update?.costDetails?.total ?? 0) - (100 * 1.4 + 20 * 4.4) / 1e6) < 1e-9);
    assert.equal(update?.metadata?.role, "advisor");
    assert.equal("advisor" in (update?.metadata ?? {}), false); // unsuffixed file → no advisor name
    assert.equal(update?.model, "glm-5.2");
    assert.equal(gen.observation.ended, true);
  }
  assert.equal(agentState.advisorTotals.generations, 2);
  assert.equal(agentState.advisorTotals.tokens, 240);
  assert.ok(Math.abs(agentState.advisorTotals.costUsd - (2 * (100 * 1.4 + 20 * 4.4)) / 1e6) < 1e-9);

  // Offsets advanced: a later record pairs only with a newly pending generation.
  const gen1Updates = gen1.observation.updates.length;
  await appendFile(transcriptFile, `${assistantRecord("glm-5.2", 7, 3)}\n`);
  const gen3 = makeAdvisorGeneration("adv-3");
  agentState.activeGenerations.set("adv-3", gen3);
  agentState.generationOrder.push("adv-3");
  agentState.pendingAdvisorGenerations.push("adv-3");

  await reconcileAdvisorUsage();

  assert.equal(gen3.observation.ended, true);
  assert.equal(gen3.observation.updates.at(-1)?.usageDetails?.input, 7);
  assert.equal(gen1.observation.updates.length, gen1Updates); // history is never re-closed
  assert.equal(agentState.advisorTotals.generations, 3);
});

test("records with no pending generation are consumed and dropped", async () => {
  clearAllSessionStates();
  setCurrentSession("advisor-drop");
  const { sessionFile, transcriptFile } = await makeTranscriptDir();
  await writeFile(transcriptFile, `${assistantRecord()}\n${assistantRecord()}\n`);
  state.sessionFilePath = sessionFile;

  const gen1 = makeAdvisorGeneration("adv-1");
  const agentState = makeAgentState(["adv-1"], [gen1]);
  state.agentState = agentState;

  await reconcileAdvisorUsage();

  assert.equal(gen1.observation.ended, true);
  assert.equal(agentState.advisorTotals.generations, 1);
  assert.equal(agentState.advisorTotals.tokens, 120); // second record dropped, not accumulated
});

test("malformed transcript lines are skipped without failing reconciliation", async () => {
  clearAllSessionStates();
  setCurrentSession("advisor-malformed");
  const { sessionFile, transcriptFile } = await makeTranscriptDir();
  await writeFile(transcriptFile, `{"role": "assistant", "broken\n${assistantRecord()}\n`);
  state.sessionFilePath = sessionFile;

  const gen1 = makeAdvisorGeneration("adv-1");
  const agentState = makeAgentState(["adv-1"], [gen1]);
  state.agentState = agentState;

  await reconcileAdvisorUsage();

  assert.equal(gen1.observation.ended, true);
  assert.equal(gen1.observation.updates.at(-1)?.usageDetails?.input, 100);
  assert.equal(agentState.advisorTotals.generations, 1);
});

test("named advisor transcripts tag metadata.advisor with the file slug", async () => {
  clearAllSessionStates();
  setCurrentSession("advisor-slug");
  const { sessionFile, transcriptFile } = await makeTranscriptDir("__advisor.security.jsonl");
  await writeFile(transcriptFile, `${assistantRecord()}\n`);
  state.sessionFilePath = sessionFile;

  const gen1 = makeAdvisorGeneration("adv-1");
  const agentState = makeAgentState(["adv-1"], [gen1]);
  state.agentState = agentState;

  await reconcileAdvisorUsage();

  const update = gen1.observation.updates.at(-1);
  assert.equal(update?.metadata?.role, "advisor");
  assert.equal(update?.metadata?.advisor, "security");
});

test("reconcile is a no-op without pending generations or a resolvable transcript dir", async () => {
  clearAllSessionStates();
  setCurrentSession("advisor-noop");
  state.sessionFilePath = "/nonexistent/dir/sess.jsonl";
  const agentState = makeAgentState(["adv-1"], [makeAdvisorGeneration("adv-1")]);
  state.agentState = agentState;

  await reconcileAdvisorUsage(); // missing dir → quiet return

  assert.equal(agentState.activeGenerations.get("adv-1")?.ended, false);
  assert.equal(agentState.advisorTotals.generations, 0);
});
