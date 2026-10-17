import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { advancementFileFor, hasFreeTheEnd } from "../src/advancement.js";

const playerUuid = "123e4567-e89b-12d3-a456-426614174000";

async function advancementDirectory(t) {
  const worldDir = await mkdtemp(path.join(os.tmpdir(), "minecraft-world-"));
  t.after(() => rm(worldDir, { recursive: true, force: true }));
  await mkdir(path.join(worldDir, "advancements"));
  return worldDir;
}

test("hasFreeTheEnd recognizes the bot's server-owned award", async t => {
  const worldDir = await advancementDirectory(t);
  const file = advancementFileFor({ worldDir, playerUuid });
  await writeFile(
    file,
    JSON.stringify({
      "minecraft:end/kill_dragon": {
        criteria: { killed_dragon: "2026-10-17 00:00:00 +0000" },
        done: true,
      },
    }),
  );

  assert.equal(hasFreeTheEnd({ advancementFile: file, playerUuid }), true);
});

test("hasFreeTheEnd rejects a missing award", async t => {
  const worldDir = await advancementDirectory(t);
  const file = advancementFileFor({ worldDir, playerUuid });
  await writeFile(file, "{}");

  assert.equal(hasFreeTheEnd({ advancementFile: file, playerUuid }), false);
});

test("hasFreeTheEnd rejects a file for a different UUID", async t => {
  const worldDir = await advancementDirectory(t);
  const file = advancementFileFor({ worldDir, playerUuid });
  await writeFile(
    file,
    JSON.stringify({
      "minecraft:end/kill_dragon": { criteria: { killed_dragon: "now" }, done: true },
    }),
  );

  assert.equal(
    hasFreeTheEnd({
      advancementFile: file,
      playerUuid: "123e4567-e89b-12d3-a456-426614174001",
    }),
    false,
  );
});
