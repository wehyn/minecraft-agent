import mineflayer from "mineflayer";

const MAX_NEARBY_BLOCKS = 16;
const NEARBY_BLOCK_RADIUS = 8;
const DIFFICULTY_NAMES = ["peaceful", "easy", "normal", "hard"];
const CONNECT_TIMEOUT_MS = 45_000;
const DISCONNECT_TIMEOUT_MS = 2_000;
const WALK_DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const WALK_HAZARDS = new Set([
  "cactus",
  "campfire",
  "fire",
  "lava",
  "magma_block",
  "powder_snow",
  "pointed_dripstone",
  "soul_campfire",
  "soul_fire",
  "sweet_berry_bush",
  "water",
  "bubble_column",
]);
const failedBots = new WeakSet();
const endedBots = new WeakSet();
const disconnects = new WeakMap();
const difficultyByBot = new WeakMap();
const configuredPathfinders = new WeakSet();

function waitForEvent(bot, eventName, timeoutMs, signal, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = error => {
      clearTimeout(timer);
      bot.removeListener(eventName, onEvent);
      bot.removeListener("error", onError);
      bot.removeListener("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onEvent = () => finish();
    const onError = () => finish(new Error("Minecraft connection failed"));
    const onEnd = () => finish(new Error("Minecraft connection ended"));
    const onAbort = () => finish(new Error("Minecraft connection aborted"));

    bot.once(eventName, onEvent);
    bot.once("error", onError);
    bot.once("end", onEnd);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();

    timer = setTimeout(
      () => finish(new Error(timeoutMessage)),
      Math.max(0, timeoutMs),
    );
    timer.unref?.();
  });
}

function waitForChunks(bot, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = error => {
      clearTimeout(timer);
      bot.removeListener("error", onError);
      bot.removeListener("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onError = () => finish(new Error("Minecraft connection failed"));
    const onEnd = () => finish(new Error("Minecraft connection ended"));
    const onAbort = () => finish(new Error("Minecraft connection aborted"));

    bot.once("error", onError);
    bot.once("end", onEnd);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();

    timer = setTimeout(
      () => finish(new Error("Minecraft chunk load timed out")),
      Math.max(0, timeoutMs),
    );
    timer.unref?.();

    Promise.resolve()
      .then(() => bot.waitForChunksToLoad())
      .then(() => finish(), () => finish(new Error("Minecraft chunk load failed")));
  });
}

function finitePosition(position) {
  return (
    position &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    Number.isFinite(position.z)
  );
}

function safeMovementTargets(bot, position) {
  const y = Math.floor(position.y);
  const at = (x, blockY, z) =>
    bot.blockAt(
      position.offset
        ? position.offset(x - position.x, blockY - position.y, z - position.z)
        : { x, y: blockY, z },
    );
  const targets = [];

  for (const [dx, dz] of WALK_DIRECTIONS) {
    let clearPath = true;
    for (let distance = 1; distance <= 2; distance += 1) {
      const x = Math.floor(position.x) + dx * distance;
      const z = Math.floor(position.z) + dz * distance;
      const floor = at(x, y - 1, z);
      const feet = at(x, y, z);
      const head = at(x, y + 1, z);
      if (
        floor?.boundingBox !== "block" ||
        feet?.boundingBox !== "empty" ||
        head?.boundingBox !== "empty" ||
        WALK_HAZARDS.has(floor.name) ||
        WALK_HAZARDS.has(feet.name) ||
        WALK_HAZARDS.has(head.name)
      ) {
        clearPath = false;
        break;
      }
    }
    if (clearPath) {
      targets.push({
        x: Math.floor(position.x) + dx * 2,
        y,
        z: Math.floor(position.z) + dz * 2,
      });
    }
  }
  return targets;
}

export function observe(bot) {
  try {
    const entity = bot?.entity;
    const position = entity?.position;
    const inventory = bot?.inventory?.items?.();
    const difficulty = difficultyByBot.get(bot) ?? bot?.game?.difficulty;
    if (
      failedBots.has(bot) ||
      !finitePosition(position) ||
      !Number.isFinite(entity.eyeHeight) ||
      !Number.isFinite(bot.health) ||
      !Number.isFinite(bot.food) ||
      !Number.isFinite(bot.time?.age) ||
      !Number.isFinite(entity.yaw) ||
      !Number.isFinite(entity.pitch) ||
      typeof bot.game?.dimension !== "string" ||
      typeof difficulty !== "string" ||
      !Array.isArray(inventory)
    ) {
      throw new Error();
    }

    const nearbyBlocks = bot
      .findBlocks({
        matching: block => block.name !== "air",
        maxDistance: NEARBY_BLOCK_RADIUS,
        count: MAX_NEARBY_BLOCKS,
      })
      .map(point => bot.blockAt(point))
      .filter(
        block =>
          block &&
          typeof block.name === "string" &&
          finitePosition(block.position) &&
          Math.hypot(
            block.position.x - position.x,
            block.position.y - position.y,
            block.position.z - position.z,
          ) <= NEARBY_BLOCK_RADIUS,
      )
      .sort(
        (a, b) =>
          Math.hypot(
            a.position.x - position.x,
            a.position.y - position.y,
            a.position.z - position.z,
          ) -
          Math.hypot(
            b.position.x - position.x,
            b.position.y - position.y,
            b.position.z - position.z,
          ),
      )
      .slice(0, MAX_NEARBY_BLOCKS)
      .map(block => ({
        name: block.name,
        position: {
          x: block.position.x,
          y: block.position.y,
          z: block.position.z,
        },
      }));

    const inventorySummary = inventory.slice(0, 100).map(item => {
      if (
        typeof item.name !== "string" ||
        !Number.isInteger(item.count) ||
        item.count < 1
      ) {
        throw new Error();
      }
      return { name: item.name, count: item.count };
    });

    return {
      position: { x: position.x, y: position.y, z: position.z },
      eyeHeight: entity.eyeHeight,
      dimension: bot.game.dimension,
      health: bot.health,
      food: bot.food,
      difficulty,
      inventory: inventorySummary,
      tick: bot.time.age,
      yaw: entity.yaw,
      pitch: entity.pitch,
      nearbyBlocks,
      safeMovementTargets: safeMovementTargets(bot, position),
    };
  } catch {
    throw new Error("Invalid Minecraft observation");
  }
}

export async function connectBot(
  config,
  {
    mineflayerImpl = mineflayer,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    signal,
  } = {},
) {
  let bot;
  try {
    bot = mineflayerImpl.createBot({
      host: config.minecraft.host,
      port: config.minecraft.port,
      version: config.minecraft.version,
      username: config.minecraft.username,
      auth: config.minecraft.auth,
      logErrors: false,
      hideErrors: true,
    });
    bot._client.on("difficulty", ({ difficulty }) => {
      const name =
        typeof difficulty === "string"
          ? difficulty
          : DIFFICULTY_NAMES[difficulty];
      if (DIFFICULTY_NAMES.includes(name)) difficultyByBot.set(bot, name);
    });
    bot.on("error", () => failedBots.add(bot));
    bot.on("end", () => {
      failedBots.add(bot);
      endedBots.add(bot);
    });

    const deadline = Date.now() + connectTimeoutMs;
    await waitForEvent(
      bot,
      "spawn",
      deadline - Date.now(),
      signal,
      "Minecraft spawn timed out",
    );
    if (failedBots.has(bot)) throw new Error("Minecraft connection failed");
    await waitForChunks(bot, deadline - Date.now(), signal);
    if (failedBots.has(bot)) throw new Error("Minecraft connection failed");
    return bot;
  } catch (error) {
    if (bot) await disconnect(bot);
    if (
      [
        "Minecraft spawn timed out",
        "Minecraft chunk load timed out",
        "Minecraft connection aborted",
      ].includes(error.message)
    ) {
      throw error;
    }
    throw new Error("Minecraft connection failed");
  }
}

export function disconnect(bot) {
  if (!bot || typeof bot !== "object" || endedBots.has(bot)) {
    return Promise.resolve();
  }
  if (disconnects.has(bot)) return disconnects.get(bot);

  const completion = new Promise(resolve => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      bot.removeListener("end", finish);
      resolve();
    };
    bot.once("end", finish);
    timer = setTimeout(finish, DISCONNECT_TIMEOUT_MS);
    timer.unref?.();
    try {
      bot.quit();
    } catch {
      finish();
    }
  });
  disconnects.set(bot, completion);
  return completion;
}

export function configurePathfinder(bot, pathfinderModule) {
  const moduleApi = pathfinderModule.default ?? pathfinderModule;
  const plugin = pathfinderModule.pathfinder ?? moduleApi.pathfinder;
  const Movements = pathfinderModule.Movements ?? moduleApi.Movements;

  if (configuredPathfinders.has(bot)) return bot.pathfinder;
  if (!bot.pathfinder) bot.loadPlugin(plugin);

  const movements = new Movements(bot);
  if (!Array.isArray(movements.scafoldingBlocks)) {
    throw new Error("Pathfinder setup failed");
  }
  movements.canDig = false;
  movements.scafoldingBlocks = [];
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.allowSprinting = false;
  movements.maxDropDown = 1;
  bot.pathfinder.setMovements(movements);
  configuredPathfinders.add(bot);
  return bot.pathfinder;
}

export async function moveNear(bot, target, signal, pathfinderModule) {
  if (signal?.aborted) throw new Error("Action aborted");
  const loadedModule =
    pathfinderModule ?? (await import("mineflayer-pathfinder"));
  if (signal?.aborted) throw new Error("Action aborted");

  const pathfinder = configurePathfinder(bot, loadedModule);
  const moduleApi = loadedModule.default ?? loadedModule;
  const GoalNear =
    loadedModule.goals?.GoalNear ?? moduleApi.goals?.GoalNear;
  if (!GoalNear) throw new Error("Pathfinder setup failed");

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      bot.removeListener("goal_reached", onGoalReached);
      bot.removeListener("path_stop", onPathStop);
      bot.removeListener("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onGoalReached = () => finish();
    const onPathStop = () => finish(new Error("Pathfinder stopped"));
    const onEnd = () => finish(new Error("Minecraft connection ended"));
    const onAbort = () => finish(new Error("Action aborted"));

    bot.once("goal_reached", onGoalReached);
    bot.once("path_stop", onPathStop);
    bot.once("end", onEnd);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();

    try {
      pathfinder.setGoal(new GoalNear(target.x, target.y, target.z, 1));
    } catch {
      finish(new Error("Pathfinder failed"));
    }
  });
}

export function cancelPath(bot) {
  try {
    bot.pathfinder?.setGoal(null);
  } catch {
    return;
  }
}
