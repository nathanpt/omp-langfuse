import test from "node:test";
import assert from "node:assert/strict";

import {
  extractAssistantOutput,
  extractModelParameters,
  normalizeContentForLangfuse,
  shapePayload,
} from "../src/utils.ts";

test("shapePayload aborts when node budget is exceeded", () => {
  const payload = {
    keep: { value: 1 },
    blowUp: {
      nested: {
        value: 2,
      },
    },
  };

  const shaped = shapePayload(payload, { maxNodes: 3 });

  assert.deepEqual(shaped, {
    keep: {
      value: 1,
    },
    blowUp: "[payload too large]",
  });
});

test("shapePayload stops iterating wide objects after the configured key limit", () => {
  let accessed = 0;
  const payload = Object.create(null) as Record<string, number>;

  for (let index = 0; index < 200; index++) {
    Object.defineProperty(payload, `key${index}`, {
      enumerable: true,
      get() {
        accessed++;
        return index;
      },
    });
  }

  const shaped = shapePayload(payload) as Record<string, number>;

  assert.equal(Object.keys(shaped).length, 80);
  assert.equal(accessed, 80);
});

test("shapePayload preserves circular protection for normal payloads", () => {
  const payload: Record<string, unknown> = { name: "root" };
  payload.self = payload;

  const shaped = shapePayload(payload);

  assert.deepEqual(shaped, {
    name: "root",
    self: "[circular]",
  });
});

test("extractModelParameters keeps supported scalar request parameters only", () => {
  const params = extractModelParameters({
    temperature: 0.2,
    top_p: 0.95,
    topP: "0.8",
    max_tokens: 4096,
    maxTokens: 2048,
    max_completion_tokens: 8192,
    presence_penalty: 0,
    frequency_penalty: -0.1,
    reasoning_effort: "medium",
    unsupported: "ignored",
    nested: { temperature: 1 },
    stop: ["\n"],
  });

  assert.deepEqual(params, {
    temperature: 0.2,
    top_p: 0.95,
    topP: "0.8",
    max_tokens: 4096,
    maxTokens: 2048,
    max_completion_tokens: 8192,
    presence_penalty: 0,
    frequency_penalty: -0.1,
    reasoning_effort: "medium",
  });
});

test("normalizeContentForLangfuse converts Pi toolCall content to OpenAI tool_calls", () => {
  const normalized = normalizeContentForLangfuse([
    { type: "text", text: "I'll inspect it." },
    { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
  ]);

  assert.deepEqual(normalized, {
    role: "assistant",
    content: "I'll inspect it.",
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "bash",
          arguments: "{\"command\":\"pwd\"}",
        },
      },
    ],
  });
});

test("normalizeContentForLangfuse converts Pi toolCall content to Anthropic tool_use blocks", () => {
  const normalized = normalizeContentForLangfuse([
    { type: "text", text: "I'll inspect it." },
    { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
  ], "anthropic-messages");

  assert.deepEqual(normalized, [
    { type: "text", text: "I'll inspect it." },
    { type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } },
  ]);
});

test("extractAssistantOutput preserves tool calls when assistant content also has text", () => {
  const output = extractAssistantOutput({
    role: "assistant",
    api: "openai-chat",
    content: [
      { type: "text", text: "I'll inspect it." },
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
    ],
  });

  assert.deepEqual(output, {
    role: "assistant",
    content: "I'll inspect it.",
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "bash",
          arguments: "{\"command\":\"pwd\"}",
        },
      },
    ],
  });
});

test("extractAssistantOutput redacts toolCall arguments before stringifying OpenAI tool calls", () => {
  const output = extractAssistantOutput({
    role: "assistant",
    api: "openai-chat",
    content: [
      { type: "toolCall", id: "call-1", name: "deploy", arguments: { password: "secret-value" } },
    ],
  }) as { tool_calls: Array<{ function: { arguments: string } }> };

  assert.equal(typeof output.tool_calls[0]?.function.arguments, "string");
  assert.deepEqual(JSON.parse(output.tool_calls[0]?.function.arguments ?? ""), {
    password: "[REDACTED_SECRET]",
  });
});
