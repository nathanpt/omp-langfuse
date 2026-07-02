import test from "node:test";
import assert from "node:assert/strict";

import { redactString, redactValue } from "../src/redaction.ts";
import { shapePayload } from "../src/utils.ts";

test("redacts common secrets recursively before telemetry upload", () => {
  const fakeProviderKey = ["sk", "ant", "api03", "fake-test-abcdefghijklmnop"].join("-");
  const payload = {
    prompt: `use ${fakeProviderKey}`,
    headers: {
      Authorization: "Bearer ghp_abcdefghijklmnopqrstuvwxyz123456",
      Cookie: "session=super-secret",
    },
    nested: [
      "LANGFUSE_SECRET_KEY=sk-lf-1234567890abcdef",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    ],
  };

  const redacted = redactValue(payload) as typeof payload;

  assert.equal(redacted.prompt, "use [REDACTED_SECRET]");
  assert.equal(redacted.headers.Authorization, "[REDACTED_SECRET]");
  assert.equal(redacted.headers.Cookie, "[REDACTED_SECRET]");
  assert.equal(redacted.nested[0], "LANGFUSE_SECRET_KEY=[REDACTED_SECRET]");
  assert.equal(redacted.nested[1], "[REDACTED_SECRET]");
});

test("hashes local absolute paths without exposing user or repository names", () => {
  const redacted = redactString("Wrote /Users/alice/work/private-repo/.env");

  assert.match(redacted, /Wrote \[PATH_HASH:[a-f0-9]{12}\]\/\.env/);
  assert.doesNotMatch(redacted, /alice|private-repo/);
});

test("shapePayload applies redaction while preserving truncation and circular handling", () => {
  const payload: Record<string, unknown> = {
    token: "ghp_abcdefghijklmnopqrstuvwxyz123456",
    cwd: "/Users/alice/work/private-repo",
  };
  payload.self = payload;

  const shaped = shapePayload(payload) as Record<string, unknown>;

  assert.equal(shaped.token, "[REDACTED_SECRET]");
  assert.match(String(shaped.cwd), /^\[PATH_HASH:[a-f0-9]{12}\]$/);
  assert.equal(shaped.self, "[circular]");
});

test("redacts camelCase credential field names", () => {
  const redacted = redactValue({
    apiKey: "plain-provider-key",
    accessToken: "plain-access-token",
    refreshToken: "plain-refresh-token",
    nested: {
      secretKey: "plain-secret-key",
    },
  }) as Record<string, unknown>;

  assert.deepEqual(redacted, {
    apiKey: "[REDACTED_SECRET]",
    accessToken: "[REDACTED_SECRET]",
    refreshToken: "[REDACTED_SECRET]",
    nested: {
      secretKey: "[REDACTED_SECRET]",
    },
  });
});
