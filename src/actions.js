import { cancelPath, moveNear } from "./minecraft/bot.js";

const WAIT_TICKS = 20;
const WAIT_TIMEOUT_MS = 5_000;
const LOOK_TIMEOUT_MS = 2_000;
const LOOK_TOLERANCE_DEGREES = 5;

const definitions = {
  wait_20_ticks: {
    description: "Wait for 20 game ticks",
    timeoutMs: WAIT_TIMEOUT_MS,
    build(observation) {
      return {
        id: "wait_20_ticks",
        description: this.description,
        timeoutMs: this.timeoutMs,
        startTick: observation.tick,
      };
    },
    execute(bot) {
      return bot.waitForTicks(WAIT_TICKS);
    },
    verify(candidate, _before, after) {
      const ticksElapsed = after.tick - candidate.startTick;
      return {
        status: ticksElapsed >= WAIT_TICKS ? "passed" : "failed",
        evidence: { ticksElapsed },
      };
    },
  },
  look_at_observed_block: {
    description: "Look at a nearby observed block",
    timeoutMs: LOOK_TIMEOUT_MS,
    build(observation) {
      const block = observation.nearbyBlocks[0];
      if (!block) return null;
      return {
        id: "look_at_observed_block",
        description: this.description,
        timeoutMs: this.timeoutMs,
        target: block.position,
      };
    },
    execute(bot, candidate) {
      const origin = bot.entity.position;
      const target = candidate.target;
      return bot.lookAt(
        origin.offset(
          target.x - origin.x + 0.5,
          target.y - origin.y + 0.5,
          target.z - origin.z + 0.5,
        ),
        true,
      );
    },
    verify(candidate, before, after) {
      const dx = candidate.target.x + 0.5 - before.position.x;
      const dy =
        candidate.target.y + 0.5 - before.position.y - before.eyeHeight;
      const dz = candidate.target.z + 0.5 - before.position.z;
      const horizontalDistance = Math.hypot(dx, dz);
      const targetYaw = Math.atan2(-dx, -dz);
      const targetPitch = Math.atan2(dy, horizontalDistance);
      const yawDifference = Math.abs(after.yaw - targetYaw) % (2 * Math.PI);
      const wrappedYawDifference = Math.min(
        yawDifference,
        2 * Math.PI - yawDifference,
      );
      const pitchDifference = Math.abs(after.pitch - targetPitch);
      const degreesFromTarget =
        (Math.hypot(wrappedYawDifference, pitchDifference) * 180) / Math.PI;
      return {
        status:
          degreesFromTarget <= LOOK_TOLERANCE_DEGREES ? "passed" : "failed",
        evidence: { degreesFromTarget },
      };
    },
  },
  move_near_observed_position: {
    description: "Move along a clear, supported nearby path",
    timeoutMs: 10_000,
    build(observation) {
      const target = observation.safeMovementTargets?.[0];
      if (
        !target ||
        ![target.x, target.y, target.z].every(Number.isFinite)
      ) return null;
      const position = observation.position;
      const distance = Math.hypot(
        target.x - position.x,
        target.y - position.y,
        target.z - position.z,
      );
      if (distance > 5) return null;
      return {
        id: "move_near_observed_position",
        description: this.description,
        timeoutMs: this.timeoutMs,
        target,
        radius: 1,
      };
    },
    execute(bot, candidate, signal, adapters) {
      return (adapters.moveNear ?? moveNear)(
        bot,
        candidate.target,
        signal,
        adapters.pathfinderModule,
      );
    },
    cancel: cancelPath,
    verify(candidate, _before, after) {
      const distanceBlocks = Math.hypot(
        Math.floor(candidate.target.x) - Math.floor(after.position.x),
        Math.floor(candidate.target.y) - Math.floor(after.position.y),
        Math.floor(candidate.target.z) - Math.floor(after.position.z),
      );
      return {
        status: distanceBlocks <= candidate.radius ? "passed" : "failed",
        evidence: { distanceBlocks },
      };
    },
  },
};

export function buildCandidates(observation, _goal) {
  return Object.values(definitions)
    .map(definition => definition.build(observation))
    .filter(Boolean);
}

export const ACTION_IDS = Object.freeze(Object.keys(definitions));
export const ACTION_CATALOG = Object.freeze(
  Object.entries(definitions).map(([id, { description }]) =>
    Object.freeze({ id, description }),
  ),
);

function runWithDeadline(operation, timeoutMs, signal, cancel) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const actionController = new AbortController();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const cancelAction = () => {
      actionController.abort();
      try {
        cancel?.();
      } catch {
        return;
      }
    };
    const onAbort = () => {
      cancelAction();
      finish(new Error("Action aborted"));
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cancelAction();
      finish(new Error("Action timed out"));
    }, timeoutMs);
    timer.unref?.();
    Promise.resolve()
      .then(() => operation(actionController.signal))
      .then(value => finish(null, value), () => finish(new Error("Action failed")));
  });
}

export function executeCandidate(bot, candidate, signal, adapters = {}) {
  const definition = definitions[candidate?.id];
  if (!definition || !Number.isFinite(candidate.timeoutMs)) {
    return Promise.reject(new Error("Unknown action candidate"));
  }
  if (typeof bot?.execute === "function") {
    return runWithDeadline(
      actionSignal => bot.execute(candidate, { ...adapters, signal: actionSignal }),
      candidate.timeoutMs + 1_000,
      signal,
      () => bot.cancelAction?.(),
    );
  }
  return runWithDeadline(
    actionSignal => definition.execute(bot, candidate, actionSignal, adapters),
    candidate.timeoutMs,
    signal,
    () => definition.cancel?.(bot),
  );
}

export function verifyCandidate(candidate, before, after) {
  const definition = definitions[candidate?.id];
  if (!definition?.verify) return { status: "uncertain", evidence: {} };
  return definition.verify(candidate, before, after);
}
