import {
  ACTION_CATALOG,
  buildCandidates,
  executeCandidate,
  verifyCandidate,
} from "./actions.js";
import { disconnect, observe } from "./minecraft/bot.js";
import { isValidGoal } from "./goal.js";

function stopped(reason, extra = {}) {
  return { status: "stopped", reason, ...extra };
}

function emit(publish, event) {
  try {
    publish?.(event);
  } catch {
    return;
  }
}

function complete(result, publish) {
  emit(publish, {
    type: "result",
    status: result.status,
    reason: result.reason,
    actionId: result.actionId,
    evidence: result.verification,
  });
  return result;
}

async function readSnapshot(driver, bot, after, signal) {
  if (driver) return driver.snapshot({ after, signal });
  return { observation: observe(bot), sequence: null };
}

export async function runOneCycle({
  bot,
  driver,
  goal,
  jev,
  planner,
  progress = {},
  progressStore,
  signal,
  publish,
}) {
  const actor = driver || bot;
  if (!progressStore || typeof progressStore.save !== "function") {
    return complete(stopped("checkpoint_unavailable"), publish);
  }

  emit(publish, { type: "cycle", status: "observing" });
  let first;
  try {
    first = await readSnapshot(driver, bot, undefined, signal);
  } catch {
    return complete(stopped(signal?.aborted ? "aborted" : "observation_failed"), publish);
  }

  const observation = first.observation;
  let currentGoal = goal;
  if (planner) {
    emit(publish, { type: "cycle", status: "planning" });
    try {
      currentGoal = await planner.plan({ observation, progress, signal });
    } catch {
      return complete(stopped(signal?.aborted ? "aborted" : "planner_failed"), publish);
    }
  }
  if (!isValidGoal(currentGoal)) {
    return complete(stopped("invalid_goal"), publish);
  }
  emit(publish, { type: "goal", goal: currentGoal });

  const offered = buildCandidates(observation, currentGoal);
  const choices = offered.map(({ id, description }) => ({ id, description }));
  emit(publish, { type: "options", provider: "JEVi", catalog: ACTION_CATALOG, choices });
  emit(publish, { type: "cycle", status: "choosing" });
  let selectedId;
  let decision;
  try {
    selectedId = await jev.chooseAction({
      observation,
      goal: currentGoal,
      candidates: choices,
      signal,
      onDecision: value => { decision = value; },
    });
  } catch {
    return complete(stopped(signal?.aborted ? "aborted" : "jev_failed"), publish);
  }

  if (signal?.aborted) return complete(stopped("aborted"), publish);
  if (!offered.some(candidate => candidate.id === selectedId)) {
    return complete(stopped("invalid_choice"), publish);
  }
  emit(publish, {
    type: "selection",
    provider: "JEVi",
    selectedId,
    probabilities: decision?.selectedId === selectedId ? decision.probabilities ?? null : null,
  });

  let beforeSnapshot;
  try {
    beforeSnapshot = await readSnapshot(driver, bot, first.sequence, signal);
  } catch {
    return complete(stopped(signal?.aborted ? "aborted" : "observation_failed"), publish);
  }
  const before = beforeSnapshot.observation;
  const candidate = buildCandidates(before, currentGoal).find(
    action => action.id === selectedId,
  );
  if (!candidate) {
    return complete(stopped("choice_no_longer_available"), publish);
  }

  emit(publish, { type: "cycle", status: "executing" });
  try {
    await executeCandidate(actor, candidate, signal, {
      basedOnSequence: beforeSnapshot.sequence,
      onStatus: status => emit(publish, {
        type: "execution",
        selectedId,
        status,
      }),
    });
  } catch (error) {
    const reason = signal?.aborted || error.message === "Action aborted"
      ? "aborted"
      : error.message === "Action timed out"
        ? "action_timeout"
        : "action_failed";
    return complete(stopped(reason, { actionId: selectedId }), publish);
  }

  emit(publish, { type: "cycle", status: "verifying" });
  let completionSnapshot;
  let afterSnapshot;
  try {
    completionSnapshot = await readSnapshot(driver, bot, undefined, signal);
    afterSnapshot = await readSnapshot(
      driver,
      bot,
      completionSnapshot.sequence,
      signal,
    );
  } catch {
    return complete(stopped(signal?.aborted ? "aborted" : "observation_failed"), publish);
  }
  const after = afterSnapshot.observation;
  const verification = verifyCandidate(candidate, before, after);
  emit(publish, {
    type: "verification",
    selectedId,
    status: verification.status,
    evidence: verification.evidence,
  });
  if (verification.status !== "passed") {
    return complete(stopped(
      verification.status === "uncertain"
        ? "uncertain_postcondition"
        : "postcondition_failed",
      { actionId: selectedId, verification: verification.evidence },
    ), publish);
  }

  const actionOutcome = {
    id: candidate.id,
    outcome: "verified",
    at: new Date().toISOString(),
    evidence: verification.evidence,
  };
  const nextProgress = {
    ...progress,
    victory: "unknown",
    currentGoal,
    actionOutcomes: [...(progress.actionOutcomes || []), actionOutcome].slice(-100),
  };
  try {
    await progressStore.save(nextProgress);
  } catch {
    emit(publish, { type: "checkpoint", status: "failed" });
    return complete(stopped("checkpoint_failed", {
      actionId: candidate.id,
      verification: verification.evidence,
    }), publish);
  }

  emit(publish, { type: "checkpoint", status: "saved" });
  emit(publish, { type: "cycle", status: "verified" });
  return complete({
    status: "verified",
    actionId: candidate.id,
    goal: currentGoal,
    observation: after,
    verification: verification.evidence,
  }, publish);
}

export async function stopAgent({ bot, driver, controller } = {}) {
  if (controller && !controller.signal.aborted) controller.abort();
  if (driver) await driver.close();
  if (bot) await disconnect(bot);
}
