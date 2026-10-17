import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const mainFile = path.resolve("src/main.js");

function runAgent(environment) {
  return spawnSync(
    process.execPath,
    [mainFile, "smoke:agent"],
    {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
      timeout: 3000,
    },
  );
}

test("agent CLI rejects a missing Codex-LB key before connecting", () => {
  const result = runAgent({
    ...process.env,
    CODEX_LB_API_KEY: "",
    TYPESAFE_API_KEY: "",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing CODEX_LB_API_KEY/);
  assert.doesNotMatch(result.stdout + result.stderr, /secret-value/);
});

test("agent CLI rejects a missing TypeSafe key without printing the Codex key", () => {
  const secret = "codex-test-secret";
  const result = runAgent({
    ...process.env,
    CODEX_LB_API_KEY: secret,
    TYPESAFE_API_KEY: "",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing TYPESAFE_API_KEY/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
});
