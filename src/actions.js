import { cancelPath, moveNear } from "./minecraft/bot.js";

const WAIT_TICKS = 20;
const WAIT_TIMEOUT_MS = 5_000;
const LOOK_TIMEOUT_MS = 2_000;
const LOOK_TOLERANCE_DEGREES = 5;
const RESUME_TIMEOUT_MS = 2_000;
const MINE_LOG_TIMEOUT_MS = 20_000;
const CRAFT_TIMEOUT_MS = 5_000;
const MAX_MINING_REACH = 4.5;
const MOVEMENT_ACTION_ID = "move_near_observed_position";
const MOVEMENT_CHOICES = [
  { id: "move_east", direction: "east", dx: 1, dz: 0 },
  { id: "move_west", direction: "west", dx: -1, dz: 0 },
  { id: "move_south", direction: "south", dx: 0, dz: 1 },
  { id: "move_north", direction: "north", dx: 0, dz: -1 },
].map(choice => ({
  ...choice,
  description: `Move ${choice.direction} along a clear, supported nearby path`,
}));
const WOOD_TYPES = new Set([
  "acacia", "birch", "cherry", "crimson", "dark_oak", "jungle",
  "mangrove", "oak", "pale_oak", "spruce", "warped",
]);

function planksForLog(itemName) {
  const name = itemName.startsWith("stripped_")
    ? itemName.slice("stripped_".length)
    : itemName;
  const suffix = ["_log", "_wood", "_stem", "_hyphae"].find(value =>
    name.endsWith(value),
  );
  if (!suffix) return null;
  const wood = name.slice(0, -suffix.length);
  return WOOD_TYPES.has(wood) ? wood + "_planks" : null;
}

function isPlanksName(itemName) {
  return itemName.endsWith("_planks") &&
    WOOD_TYPES.has(itemName.slice(0, -"_planks".length));
}

function inventoryCount(inventory, itemName) {
  return (inventory || []).reduce(
    (total, item) => total + (item.name === itemName ? item.count : 0),
    0,
  );
}

function craftingCandidate(id, definition, observation, inputMatches, inputCount, outputItem, outputCount) {
  const input = observation.inventory?.find(
    item => item.count >= inputCount && inputMatches(item.name),
  );
  if (!input) return null;
  const expectedOutput = typeof outputItem === "function"
    ? outputItem(input.name)
    : outputItem;
  if (!expectedOutput) return null;
  return {
    id,
    description: definition.description,
    timeoutMs: definition.timeoutMs,
    inputItem: input.name,
    outputItem: expectedOutput,
    inputCount,
    outputCount,
  };
}

function verifyCrafting(candidate, before, after) {
  const inputConsumed =
    inventoryCount(before.inventory, candidate.inputItem) -
    inventoryCount(after.inventory, candidate.inputItem);
  const outputGained =
    inventoryCount(after.inventory, candidate.outputItem) -
    inventoryCount(before.inventory, candidate.outputItem);
  return {
    status:
      inputConsumed === candidate.inputCount &&
      outputGained >= candidate.outputCount
        ? "passed"
        : "failed",
    evidence: { inputConsumed, outputGained },
  };
}

function prismActionOnly() {
  throw new Error("Prism action required");
}

const definitions = {
  resume_game: {
    description: "Resume the paused game",
    timeoutMs: RESUME_TIMEOUT_MS,
    build(observation) {
      if (!observation.gameMenuOpen) return null;
      return {
        id: "resume_game",
        description: this.description,
        timeoutMs: this.timeoutMs,
      };
    },
    execute: prismActionOnly,
    verify(_candidate, _before, after) {
      return {
        status: after.gameMenuOpen === false ? "passed" : "failed",
        evidence: { gameMenuOpen: after.gameMenuOpen },
      };
    },
  },
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
  mine_observed_log: {
    description: "Mine a nearby Overworld log and collect its drop",
    timeoutMs: MINE_LOG_TIMEOUT_MS,
    build(observation) {
      if (!["overworld", "minecraft:overworld"].includes(observation.dimension)) {
        return null;
      }
      const block = observation.nearbyBlocks?.find(value => {
        const outputItem = planksForLog(value.name);
        return outputItem && value.visible !== false && Math.hypot(
          value.position.x + 0.5 - observation.position.x,
          value.position.y + 0.5 - observation.position.y - observation.eyeHeight,
          value.position.z + 0.5 - observation.position.z,
        ) <= MAX_MINING_REACH;
      });
      if (!block) return null;
      return {
        id: "mine_observed_log",
        description: this.description,
        timeoutMs: this.timeoutMs,
        target: block.position,
        inputItem: block.name,
      };
    },
    execute: prismActionOnly,
    verify(candidate, before, after) {
      const blockRemoved = !after.nearbyBlocks?.some(block =>
        block.name === candidate.inputItem &&
        block.position.x === candidate.target.x &&
        block.position.y === candidate.target.y &&
        block.position.z === candidate.target.z,
      );
      const dropsCollected =
        inventoryCount(after.inventory, candidate.inputItem) -
        inventoryCount(before.inventory, candidate.inputItem);
      return {
        status: blockRemoved && dropsCollected >= 1 ? "passed" : "failed",
        evidence: { blockRemoved, dropsCollected },
      };
    },
  },
  craft_planks_from_logs: {
    description: "Craft planks from one log",
    timeoutMs: CRAFT_TIMEOUT_MS,
    build(observation) {
      return craftingCandidate(
        "craft_planks_from_logs",
        this,
        observation,
        name => planksForLog(name) !== null,
        1,
        planksForLog,
        4,
      );
    },
    execute: prismActionOnly,
    verify: verifyCrafting,
  },
  craft_sticks_from_planks: {
    description: "Craft sticks from two planks",
    timeoutMs: CRAFT_TIMEOUT_MS,
    build(observation) {
      return craftingCandidate(
        "craft_sticks_from_planks",
        this,
        observation,
        name => isPlanksName(name),
        2,
        "stick",
        4,
      );
    },
    execute: prismActionOnly,
    verify: verifyCrafting,
  },
  craft_table_from_planks: {
    description: "Craft a crafting table from four planks",
    timeoutMs: CRAFT_TIMEOUT_MS,
    build(observation) {
      return craftingCandidate(
        "craft_table_from_planks",
        this,
        observation,
        name => isPlanksName(name),
        4,
        "crafting_table",
        1,
      );
    },
    execute: prismActionOnly,
    verify: verifyCrafting,
  },
  [MOVEMENT_ACTION_ID]: {
    timeoutMs: 10_000,
    execute(bot, candidate, signal, adapters) {
      return (adapters.moveNear ?? moveNear)(
        bot,
        candidate.target,
        signal,
        adapters.pathfinderModule,
        candidate.radius,
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

function movementCandidates(observation) {
  const targetsByDirection = new Map();
  for (const target of observation.safeMovementTargets || []) {
    if (!target || ![target.x, target.y, target.z].every(Number.isInteger)) {
      continue;
    }
    const dx = target.x - Math.floor(observation.position.x);
    const dy = target.y - Math.floor(observation.position.y);
    const dz = target.z - Math.floor(observation.position.z);
    const steps = Math.abs(dx) + Math.abs(dz);
    const direction = MOVEMENT_CHOICES.find(choice =>
      choice.dx === Math.sign(dx) && choice.dz === Math.sign(dz),
    );
    if (dy !== 0 || !direction || ![1, 2].includes(steps)) continue;
    const existing = targetsByDirection.get(direction.id);
    if (!existing || steps < existing.steps) {
      targetsByDirection.set(direction.id, { target, steps });
    }
  }
  return MOVEMENT_CHOICES.flatMap(direction => {
    const movement = targetsByDirection.get(direction.id);
    if (!movement) return [];
    return [{
      id: MOVEMENT_ACTION_ID,
      choiceId: direction.id,
      description: direction.description,
      timeoutMs: definitions[MOVEMENT_ACTION_ID].timeoutMs,
      target: movement.target,
      radius: movement.steps === 1 ? 0 : 1,
    }];
  });
}

export function buildCandidates(observation, _goal) {
  if (observation.gameMenuOpen) {
    return [definitions.resume_game.build(observation)];
  }
  if (observation.screenOpen) return [];
  const candidates = Object.entries(definitions)
    .filter(([id]) => id !== MOVEMENT_ACTION_ID)
    .map(([, definition]) => definition.build(observation))
    .filter(Boolean);
  return [...candidates, ...movementCandidates(observation)];
}

export const ACTION_IDS = Object.freeze(Object.keys(definitions));
export const ACTION_CATALOG = Object.freeze(
  [
    ...Object.entries(definitions)
      .filter(([id]) => id !== MOVEMENT_ACTION_ID)
      .map(([id, { description }]) => Object.freeze({ id, description })),
    ...MOVEMENT_CHOICES.map(({ id, description }) =>
      Object.freeze({ id, description }),
    ),
  ],
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
