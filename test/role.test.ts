import test from "node:test";
import assert from "node:assert/strict";

import {
  extractPayloadModel,
  getToolNames,
  inferGenerationRole,
  readOtelRoleHint,
} from "../src/role.ts";

test("inferGenerationRole detects the advisor via anthropic-style tool names", () => {
  assert.equal(inferGenerationRole({ tools: [{ name: "advise" }, { name: "read" }] }), "advisor");
});

test("inferGenerationRole detects the advisor via openai-style tool names", () => {
  assert.equal(
    inferGenerationRole({ tools: [{ type: "function", function: { name: "advise" } }] }),
    "advisor",
  );
});

test("inferGenerationRole classifies primary payloads as default", () => {
  assert.equal(inferGenerationRole({ tools: [{ name: "bash" }] }), "default");
  assert.equal(inferGenerationRole({ tools: [] }), "default");
  assert.equal(inferGenerationRole({}), "default");
  assert.equal(inferGenerationRole(undefined), "default");
});

test("getToolNames collects names across dialects and skips non-objects", () => {
  assert.deepEqual(
    getToolNames({ tools: [{ name: "advise" }, "not-an-object", { function: { name: "bash" } }, {}] }),
    ["advise", "bash"],
  );
  assert.deepEqual(getToolNames({ tools: "nope" }), []);
  assert.deepEqual(getToolNames(null), []);
});

test("extractPayloadModel returns the payload model only when a non-empty string", () => {
  assert.equal(extractPayloadModel({ model: "glm-5.2" }), "glm-5.2");
  assert.equal(extractPayloadModel({ model: "" }), undefined);
  assert.equal(extractPayloadModel({ model: 123 }), undefined);
  assert.equal(extractPayloadModel({}), undefined);
  assert.equal(extractPayloadModel(undefined), undefined);
});

test("readOtelRoleHint returns undefined without an active span", () => {
  // No OTel tracer is registered in tests — the default no-OTEL runtime path.
  assert.equal(readOtelRoleHint("some-session"), undefined);
});
