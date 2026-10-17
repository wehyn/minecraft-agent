import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isValidGoal } from "./goal.js";

const ACTION_IDS = new Set([
  "wait_20_ticks",
  "look_at_observed_block",
  "move_near_observed_position",
]);

function emptyProgress() {
  return {
    schemaVersion: 1,
    run: {
      minecraftVersion: null,
      seed: null,
      difficulty: null,
      startedAt: null,
      elapsedMs: 0,
      deaths: null,
      retries: null,
    },
    currentGoal: null,
    verifiedMilestones: [],
    actionOutcomes: [],
    victory: "unknown",
  };
}

function validDate(value, nullable = false) {
  return (
    (nullable && value === null) ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)))
  );
}

function validEvidence(id, evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return false;
  }
  const keys = Object.keys(evidence);
  if (id === "wait_20_ticks") {
    return (
      keys.length === 1 &&
      keys[0] === "ticksElapsed" &&
      Number.isFinite(evidence.ticksElapsed) &&
      evidence.ticksElapsed >= 20
    );
  }
  if (id === "look_at_observed_block") {
    return (
      keys.length === 1 &&
      keys[0] === "degreesFromTarget" &&
      Number.isFinite(evidence.degreesFromTarget) &&
      evidence.degreesFromTarget >= 0 &&
      evidence.degreesFromTarget <= 5
    );
  }
  return (
    keys.length === 1 &&
    keys[0] === "distanceBlocks" &&
    Number.isFinite(evidence.distanceBlocks) &&
    evidence.distanceBlocks >= 0 &&
    evidence.distanceBlocks <= 1
  );
}

function validActionOutcome(outcome) {
  return (
    outcome &&
    typeof outcome === "object" &&
    !Array.isArray(outcome) &&
    Object.keys(outcome).length === 4 &&
    ACTION_IDS.has(outcome.id) &&
    outcome.outcome === "verified" &&
    validDate(outcome.at) &&
    validEvidence(outcome.id, outcome.evidence)
  );
}

function isProgress(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 6 ||
    value.schemaVersion !== 1 ||
    !value.run ||
    typeof value.run !== "object" ||
    Array.isArray(value.run) ||
    Object.keys(value.run).length !== 7 ||
    !(value.run.minecraftVersion === null ||
      typeof value.run.minecraftVersion === "string") ||
    !(value.run.seed === null || typeof value.run.seed === "string") ||
    !(value.run.difficulty === null ||
      typeof value.run.difficulty === "string") ||
    !validDate(value.run.startedAt, true) ||
    !Number.isFinite(value.run.elapsedMs) ||
    value.run.elapsedMs < 0 ||
    !(value.run.deaths === null ||
      (Number.isInteger(value.run.deaths) && value.run.deaths >= 0)) ||
    !(value.run.retries === null ||
      (Number.isInteger(value.run.retries) && value.run.retries >= 0)) ||
    !(value.currentGoal === null || isValidGoal(value.currentGoal)) ||
    !Array.isArray(value.verifiedMilestones) ||
    value.verifiedMilestones.length > 100 ||
    value.verifiedMilestones.some(
      milestone =>
        typeof milestone !== "string" || milestone.length > 200,
    ) ||
    !Array.isArray(value.actionOutcomes) ||
    value.actionOutcomes.length > 100 ||
    value.actionOutcomes.some(outcome => !validActionOutcome(outcome)) ||
    !["unknown", "not_awarded", "confirmed"].includes(value.victory)
  ) {
    return false;
  }
  return true;
}

export async function loadProgress(file) {
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return emptyProgress();
    throw new Error("Progress file unavailable");
  }

  let progress;
  try {
    progress = JSON.parse(content);
  } catch {
    throw new Error("Invalid progress file");
  }
  if (!isProgress(progress)) throw new Error("Invalid progress file");
  return progress;
}

async function validateExistingProgress(file) {
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error("Progress file unavailable");
  }

  try {
    if (!isProgress(JSON.parse(content))) throw new Error();
  } catch {
    throw new Error("Invalid progress file");
  }
}

export async function saveProgress(file, progress) {
  if (!isProgress(progress)) throw new Error("Invalid progress record");
  await validateExistingProgress(file);

  const directory = path.dirname(file);
  const temporaryFile = path.join(
    directory,
    "." + path.basename(file) + "." + randomUUID() + ".tmp",
  );
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporaryFile, JSON.stringify(progress) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryFile, file);
  } catch {
    await rm(temporaryFile, { force: true }).catch(() => {});
    throw new Error("Progress save failed");
  }
}
