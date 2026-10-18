import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProgress, saveProgress } from "../src/progress.js";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "minecraft-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("loadProgress starts with an empty versioned record when the file is missing", async t => {
  const directory = await temporaryDirectory(t);
  const progress = await loadProgress(path.join(directory, "progress.json"));

  assert.equal(progress.schemaVersion, 1);
  assert.deepEqual(progress.run, {
    minecraftVersion: null,
    seed: null,
    difficulty: null,
    startedAt: null,
    elapsedMs: 0,
    deaths: null,
    retries: null,
  });
  assert.equal(progress.currentGoal, null);
  assert.deepEqual(progress.verifiedMilestones, []);
  assert.deepEqual(progress.actionOutcomes, []);
  assert.equal(progress.victory, "unknown");
});

test("loadProgress rejects corrupt data without changing the file", async t => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "progress.json");
  const original = '{"schemaVersion":';
  await writeFile(file, original);

  await assert.rejects(loadProgress(file), /Invalid progress file/);
  assert.equal(await readFile(file, "utf8"), original);
});

test("saveProgress persists a verified record that loads unchanged", async t => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "progress.json");
  const progress = await loadProgress(file);
  progress.run = {
    minecraftVersion: "1.21.8",
    seed: null,
    difficulty: "normal",
    startedAt: "2026-10-17T00:00:00.000Z",
    elapsedMs: 2500,
    deaths: null,
    retries: null,
  };
  progress.currentGoal = {
    objective: "Wait safely",
    successCriteria: ["Observe 20 game ticks"],
  };
  progress.actionOutcomes.push({
    id: "wait_20_ticks",
    outcome: "verified",
    at: "2026-10-17T00:00:02.500Z",
    evidence: { ticksElapsed: 20 },
  });

  await saveProgress(file, progress);

  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), progress);
  assert.deepEqual(await loadProgress(file), progress);
});

test("saveProgress keeps verified menu, log, and crafting outcomes", async t => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "progress.json");
  const progress = await loadProgress(file);
  const at = "2026-10-17T00:00:02.500Z";
  progress.actionOutcomes = [
    { id: "resume_game", outcome: "verified", at, evidence: { gameMenuOpen: false } },
    { id: "mine_observed_log", outcome: "verified", at, evidence: { blockRemoved: true, dropsCollected: 1 } },
    { id: "craft_planks_from_logs", outcome: "verified", at, evidence: { inputConsumed: 1, outputGained: 4 } },
    { id: "craft_sticks_from_planks", outcome: "verified", at, evidence: { inputConsumed: 2, outputGained: 4 } },
    { id: "craft_table_from_planks", outcome: "verified", at, evidence: { inputConsumed: 4, outputGained: 1 } },
  ];

  await saveProgress(file, progress);

  assert.deepEqual(await loadProgress(file), progress);
});

test("saveProgress refuses to replace an existing corrupt record", async t => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, "progress.json");
  const original = "not valid progress";
  await writeFile(file, original);

  await assert.rejects(saveProgress(file, await loadProgress(path.join(directory, "missing.json"))));
  assert.equal(await readFile(file, "utf8"), original);
});
