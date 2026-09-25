import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectSubagentSession,
  resolveSessionScope,
  subagentTraceName,
} from "../src/subagent.ts";
import { rememberParentTrace, lookupParentTrace, clearParentTraceRegistry } from "../src/parent-trace.ts";
import { clearAllSessionStates } from "../src/state.ts";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "omp-langfuse-subagent-"));
}

test("detectSubagentSession: nested artifact resolves to interactive root", async () => {
  const dir = await makeTempDir();
  await writeFile(join(dir, "parent.jsonl"), "");
  const laneDir = join(dir, "parent");
  await mkdir(laneDir);
  const laneFile = join(laneDir, "QualityLane.jsonl");
  await writeFile(laneFile, "");

  const attribution = detectSubagentSession(laneFile);
  assert.ok(attribution);
  assert.equal(attribution.taskId, "QualityLane");
  assert.equal(attribution.ownSessionId, "QualityLane");
  assert.equal(attribution.parentSessionId, "parent");
  assert.equal(attribution.parentTraceId, undefined);
  assert.equal(attribution.traceName, "omp-agent:QualityLane");
});

test("detectSubagentSession: two-level nested artifact walks to the interactive root", async () => {
  const dir = await makeTempDir();
  await writeFile(join(dir, "parent.jsonl"), "");
  const laneDir = join(dir, "parent");
  await mkdir(laneDir);
  await writeFile(join(laneDir, "QualityLane.jsonl"), "");
  const childDir = join(laneDir, "QualityLane");
  await mkdir(childDir);
  const childFile = join(childDir, "child.jsonl");
  await writeFile(childFile, "");

  const attribution = detectSubagentSession(childFile);
  assert.ok(attribution);
  // Interactive root, not the intermediate lane.
  assert.equal(attribution.parentSessionId, "parent");
  assert.equal(attribution.taskId, "child");
  assert.equal(attribution.traceName, "omp-agent:child");
});

test("detectSubagentSession: primary session file is not a subagent", async () => {
  const dir = await makeTempDir();
  const sessionFile = join(dir, "2026-09-25T18-58-56-200Z_01a0d9ef.jsonl");
  await writeFile(sessionFile, "");

  assert.equal(detectSubagentSession(sessionFile), undefined);
});

test("detectSubagentSession: temp task artifact dirs are subagents without a parent", async () => {
  const root = await makeTempDir();
  const taskDir = join(root, "omp-task-abc");
  const evalDir = join(root, "omp-eval-agent-xyz");
  const otherDir = join(root, "other");
  await mkdir(taskDir);
  await mkdir(evalDir);
  await mkdir(otherDir);
  const taskFile = join(taskDir, "Lane.jsonl");
  const evalFile = join(evalDir, "Lane.jsonl");
  const otherFile = join(otherDir, "Lane.jsonl");
  await writeFile(taskFile, "");
  await writeFile(evalFile, "");
  await writeFile(otherFile, "");

  const taskAttribution = detectSubagentSession(taskFile);
  assert.ok(taskAttribution);
  assert.equal(taskAttribution.taskId, "Lane");
  assert.equal(taskAttribution.parentSessionId, undefined);

  const evalAttribution = detectSubagentSession(evalFile);
  assert.ok(evalAttribution);
  assert.equal(evalAttribution.taskId, "Lane");
  assert.equal(evalAttribution.parentSessionId, undefined);

  assert.equal(detectSubagentSession(otherFile), undefined);
});

test("detectSubagentSession: missing or empty session file", () => {
  assert.equal(detectSubagentSession(undefined), undefined);
  assert.equal(detectSubagentSession(""), undefined);
});

test("subagentTraceName sanitizes and falls back", () => {
  assert.equal(subagentTraceName("a/b c"), "omp-agent:a_b_c");
  assert.equal(subagentTraceName("***"), "omp-agent:subagent");
});

test("resolveSessionScope: file-backed session scopes to the file stem", () => {
  const decision = resolveSessionScope({
    sessionFile: "/tmp/sessions/2026-09-25T18-58-56-200Z_01a0d9ef.jsonl",
    rawSessionId: "some-uuid",
    active: { ownerSessionId: "other-uuid", langfuseSessionId: "stem", hasOpenRoot: true },
  });
  assert.deepEqual(decision, { scopeId: "2026-09-25T18-58-56-200Z_01a0d9ef" });
  assert.equal(decision.inheritedParent, undefined);
});

test("resolveSessionScope: different in-memory session splits off with inherited parent", () => {
  const decision = resolveSessionScope({
    sessionFile: undefined,
    rawSessionId: "child-uuid",
    active: {
      ownerSessionId: "parent-uuid",
      traceId: "t1",
      langfuseSessionId: "parent-stem",
      hasOpenRoot: true,
    },
  });
  assert.deepEqual(decision, {
    scopeId: "inmem:child-uuid",
    inheritedParent: { sessionId: "parent-stem", traceId: "t1" },
  });
});

test("resolveSessionScope: same-owner events stay in the current scope", () => {
  const decision = resolveSessionScope({
    sessionFile: undefined,
    rawSessionId: "parent-uuid",
    active: {
      ownerSessionId: "parent-uuid",
      traceId: "t1",
      langfuseSessionId: "parent-stem",
      hasOpenRoot: true,
    },
  });
  assert.deepEqual(decision, {});
});

test("resolveSessionScope: no owner yet stays in the current scope", () => {
  const decision = resolveSessionScope({
    sessionFile: undefined,
    rawSessionId: "child-uuid",
    active: { langfuseSessionId: "", hasOpenRoot: true },
  });
  assert.deepEqual(decision, {});
});

test("parent trace registry: remember, overwrite, no-op, clear", () => {
  clearAllSessionStates();
  clearParentTraceRegistry();

  rememberParentTrace("parent", "trace-1");
  assert.equal(lookupParentTrace("parent"), "trace-1");

  rememberParentTrace("parent", "trace-2");
  assert.equal(lookupParentTrace("parent"), "trace-2");

  rememberParentTrace("", "trace-3");
  rememberParentTrace("other-parent", "");
  assert.equal(lookupParentTrace("other-parent"), undefined);

  clearParentTraceRegistry();
  assert.equal(lookupParentTrace("parent"), undefined);
});
