import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const commands = [
  {
    file: "scripts/smoke-codex-lb.js",
    message: "Missing CODEX_LB_API_KEY",
  },
  {
    file: "scripts/smoke-typesafe-jev.js",
    message: "Missing TYPESAFE_API_KEY",
  },
];

for (const command of commands) {
  test(command.file + " reports a missing key without a stack trace", () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve(command.file)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CODEX_LB_API_KEY: "",
          TYPESAFE_API_KEY: "",
        },
        encoding: "utf8",
        timeout: 3000,
      },
    );

    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), command.message);
  });
}
