import {
  buildCandidates,
  executeCandidate,
  verifyCandidate,
} from "./actions.js";
import { disconnect, observe } from "./minecraft/bot.js";
import { isValidGoal } from "./goal.js";

function stopped(reason) {
  return { status: "stopped", reason };
}

export async function runOneCycle({
  bot,
  goal,
  jev,
  planner,
  progress = {},
  progressStore,
  signal,
}) {
  if (!progressStore || typeof progressStore.save !== "function") {
    return stopped("checkpoint_unavailable");
  }

  let observation;
  try {
    observation = observe(bot);
  } catch {
    return stopped("observation_failed");
  }

  let currentGoal = goal;
  if (planner) {
    try {
      currentGoal = await planner.plan({ observation, progress, signal });
    } catch {
      return stopped(signal?.aborted ? "aborted" : "planner_failed");
    }
  }
  if (!isValidGoal(currentGoal)) return stopped("invalid_goal");

  const offered = buildCandidates(observation, currentGoal);
  let selectedId;
  try {
    selectedId = await jev.chooseAction({
      observation,
      goal: currentGoal,
      candidates: offered.map(({ id, description }) => ({ id, description })),
      signal,
    });
  } catch {
    return stopped(signal?.aborted ? "aborted" : "jev_failed");
  }

  if (signal?.aborted) return stopped("aborted");
  if (!offered.some(candidate => candidate.id === selectedId)) {
    return stopped("invalid_choice");
  }

  let before;
  try {
    before = observe(bot);
  } catch {
    return stopped("observation_failed");
  }
  const candidate = buildCandidates(before, currentGoal).find(
    action => action.id === selectedId,
  );
  if (!candidate) return stopped("choice_no_longer_available");

  try {
    await executeCandidate(bot, candidate, signal);
  } catch (error) {
    if (signal?.aborted || error.message === "Action aborted") {
      return stopped("aborted");
    }
    return stopped(error.message === "Action timed out" ? "action_timeout" : "action_failed");
  }

  let after;
  try {
    after = observe(bot);
  } catch {
    return stopped("observation_failed");
  }
  const verification = verifyCandidate(candidate, before, after);
  if (verification.status !== "passed") {
    return stopped(
      verification.status === "uncertain"
        ? "uncertain_postcondition"
        : "postcondition_failed",
    );
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
    return stopped("checkpoint_failed");
  }

  return {
    status: "verified",
    actionId: candidate.id,
    goal: currentGoal,
    observation: after,
    verification: verification.evidence,
  };
}

export async function stopAgent({ bot, controller } = {}) {
  if (controller && !controller.signal.aborted) controller.abort();
  if (bot) await disconnect(bot);
}
