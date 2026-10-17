import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import {
  buildCandidates,
  executeCandidate,
  verifyCandidate,
} from "../src/actions.js";
import { runOneCycle, stopAgent } from "../src/agent.js";
import {
  configurePathfinder,
  moveNear,
  observe,
} from "../src/minecraft/bot.js";

const goal = {
  objective: "Look at a nearby block",
  successCriteria: ["The bot faces the block"],
};

function fakeBot({ blocks = [], waitTicks = 20, onObserve, walkable = true } = {}) {
  const bot = new EventEmitter();
  bot.entity = {
    position: {
      x: 0,
      y: 64,
      z: 0,
      offset(x, y, z) {
        return { x: this.x + x, y: this.y + y, z: this.z + z };
      },
    },
    eyeHeight: 1.62,
    yaw: 0,
    pitch: 0,
  };
  bot.game = { dimension: "overworld", difficulty: "normal" };
  bot.health = 20;
  bot.food = 20;
  bot.inventory = { items: () => [] };
  bot.time = { age: 100 };
  bot.findBlocks = () => {
    onObserve?.();
    return blocks;
  };
  bot.blockAt = position => {
    const observedBlock = blocks.find(
      block => block.x === position.x && block.y === position.y && block.z === position.z,
    );
    if (observedBlock) {
      return { name: "stone", boundingBox: "block", position };
    }
    if (position.y < 64 && walkable) {
      return { name: "stone", boundingBox: "block", position };
    }
    return { name: "air", boundingBox: "empty", position };
  };
  bot.waitForTicksCalls = 0;
  bot.waitForTicks = async ticks => {
    bot.waitForTicksCalls += 1;
    bot.time.age += waitTicks === 20 ? ticks : waitTicks;
  };
  bot.lookAtCalls = 0;
  bot.lookAt = async point => {
    bot.lookAtCalls += 1;
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0);
    const dx = point.x - eye.x;
    const dy = point.y - eye.y;
    const dz = point.z - eye.z;
    bot.entity.yaw = Math.atan2(-dx, -dz);
    bot.entity.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  };
  bot.quitCalls = 0;
  bot.quit = () => {
    bot.quitCalls += 1;
    bot.emit("end", "quit");
  };
  return bot;
}

test("runOneCycle executes one valid JEV choice and saves verified progress", async () => {
  const bot = fakeBot();
  const saved = [];
  const result = await runOneCycle({
    bot,
    goal,
    jev: { chooseAction: async () => "wait_20_ticks" },
    progressStore: { save: async progress => saved.push(progress) },
  });

  assert.equal(result.status, "verified");
  assert.equal(result.actionId, "wait_20_ticks");
  assert.equal(bot.waitForTicksCalls, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].actionOutcomes[0].id, "wait_20_ticks");
});

test("JEV receives only candidate IDs and descriptions", async () => {
  const bot = fakeBot({
    blocks: [{ x: 1, y: 64, z: 0 }],
  });
  let received;

  await runOneCycle({
    bot,
    goal,
    jev: {
      chooseAction: async request => {
        received = request.candidates;
        return "wait_20_ticks";
      },
    },
    progressStore: { save: async () => {} },
  });

  assert.deepEqual(
    received.map(candidate => Object.keys(candidate).sort()),
    [
      ["description", "id"],
      ["description", "id"],
      ["description", "id"],
    ],
  );
});

test("runOneCycle rejects an unknown JEV choice without acting", async () => {
  const bot = fakeBot();
  const saved = [];
  const result = await runOneCycle({
    bot,
    goal,
    jev: { chooseAction: async () => "break_block" },
    progressStore: { save: async value => saved.push(value) },
  });

  assert.equal(result.status, "stopped");
  assert.equal(result.reason, "invalid_choice");
  assert.equal(bot.waitForTicksCalls, 0);
  assert.equal(bot.lookAtCalls, 0);
  assert.equal(saved.length, 0);
});

test("runOneCycle stops on JEV timeout before acting", async () => {
  const bot = fakeBot();
  const result = await runOneCycle({
    bot,
    goal,
    jev: {
      chooseAction: async () => {
        throw new Error("timeout");
      },
    },
    progressStore: { save: async () => assert.fail("saved after timeout") },
  });

  assert.equal(result.status, "stopped");
  assert.equal(bot.waitForTicksCalls, 0);
});

test("wait candidate passes after twenty observed ticks", async () => {
  const bot = fakeBot();
  const before = observe(bot);
  const candidate = buildCandidates(before, goal).find(
    action => action.id === "wait_20_ticks",
  );

  await executeCandidate(bot, candidate);
  const after = observe(bot);

  assert.deepEqual(verifyCandidate(candidate, before, after), {
    status: "passed",
    evidence: { ticksElapsed: 20 },
  });
});

test("executor stops an action at its configured timeout", async () => {
  const bot = fakeBot();
  bot.waitForTicks = async () => {
    bot.waitForTicksCalls += 1;
    return new Promise(() => {});
  };
  const candidate = buildCandidates(observe(bot), goal).find(
    action => action.id === "wait_20_ticks",
  );
  candidate.timeoutMs = 5;

  await assert.rejects(executeCandidate(bot, candidate), /Action timed out/);
  assert.equal(bot.waitForTicksCalls, 1);
});

test("look candidate passes within five degrees", async () => {
  const bot = fakeBot({ blocks: [{ x: 1, y: 64, z: 0 }] });
  const before = observe(bot);
  const candidate = buildCandidates(before, goal).find(
    action => action.id === "look_at_observed_block",
  );

  await executeCandidate(bot, candidate);
  const after = observe(bot);
  assert.equal(verifyCandidate(candidate, before, after).status, "passed");

  after.yaw += 0.2;
  assert.equal(verifyCandidate(candidate, before, after).status, "failed");
});

test("movement candidate derives a target within five blocks", () => {
  const bot = fakeBot();
  const observation = observe(bot);
  const candidate = buildCandidates(observation, goal).find(
    action => action.id === "move_near_observed_position",
  );

  assert.deepEqual(candidate.target, { x: 2, y: 64, z: 0 });
  assert.ok(
    Math.hypot(
      candidate.target.x - observation.position.x,
      candidate.target.y - observation.position.y,
      candidate.target.z - observation.position.z,
    ) <= 5,
  );
});

test("movement candidate is absent without a clear supported path", () => {
  const observation = observe(fakeBot({ walkable: false }));

  assert.equal(
    buildCandidates(observation, goal).some(
      action => action.id === "move_near_observed_position",
    ),
    false,
  );
});

test("movement verifies the observed position against its requested radius", () => {
  const bot = fakeBot();
  const before = observe(bot);
  const candidate = buildCandidates(before, goal).find(
    action => action.id === "move_near_observed_position",
  );
  const reached = {
    ...before,
    position: {
      x: candidate.target.x + 1.5,
      y: candidate.target.y,
      z: candidate.target.z,
    },
  };
  const outsideRadius = {
    ...before,
    position: {
      x: candidate.target.x + 2.5,
      y: candidate.target.y,
      z: candidate.target.z,
    },
  };

  assert.deepEqual(verifyCandidate(candidate, before, reached), {
    status: "passed",
    evidence: { distanceBlocks: 1 },
  });
  assert.deepEqual(verifyCandidate(candidate, before, outsideRadius), {
    status: "failed",
    evidence: { distanceBlocks: 2 },
  });
});

test("Pathfinder disables digging, scaffolding, towers, and parkour", () => {
  const bot = fakeBot();
  bot.loadPlugin = plugin => plugin(bot);
  let movements;
  class FakeMovements {
    constructor() {
      this.canDig = true;
      this.scafoldingBlocks = [1, 2];
      this.allow1by1towers = true;
      this.allowParkour = true;
      this.allowSprinting = true;
      this.maxDropDown = 4;
    }
  }
  const pathfinderModule = {
    pathfinder: target => {
      target.pathfinder = {
        setMovements(value) {
          movements = value;
        },
      };
    },
    Movements: FakeMovements,
  };

  configurePathfinder(bot, pathfinderModule);

  assert.equal(movements.canDig, false);
  assert.deepEqual(movements.scafoldingBlocks, []);
  assert.equal(movements.allow1by1towers, false);
  assert.equal(movements.allowParkour, false);
  assert.equal(movements.allowSprinting, false);
  assert.equal(movements.maxDropDown, 1);
});

test("moveNear completes only after Pathfinder reaches its bounded target", async () => {
  const bot = fakeBot();
  bot.loadPlugin = plugin => plugin(bot);
  let goal;
  class FakeMovements {
    constructor() {
      this.scafoldingBlocks = [];
    }
  }
  class GoalNear {
    constructor(x, y, z, range) {
      this.target = { x, y, z };
      this.range = range;
    }
  }
  const pathfinderModule = {
    pathfinder: target => {
      target.pathfinder = {
        setMovements() {},
        setGoal(value) {
          goal = value;
          queueMicrotask(() => target.emit("goal_reached"));
        },
      };
    },
    Movements: FakeMovements,
    goals: { GoalNear },
  };

  await moveNear(bot, { x: 3, y: 64, z: 0 }, undefined, pathfinderModule);

  assert.deepEqual(goal.target, { x: 3, y: 64, z: 0 });
  assert.equal(goal.range, 1);
});

test("movement timeout cancels the active Pathfinder goal", async () => {
  const bot = fakeBot();
  let stopped = 0;
  bot.pathfinder = {
    setGoal(goal) {
      if (goal === null) stopped += 1;
    },
  };
  const candidate = buildCandidates(observe(bot), goal).find(
    action => action.id === "move_near_observed_position",
  );
  candidate.timeoutMs = 5;
  let actionSignal;

  await assert.rejects(
    executeCandidate(
      bot,
      candidate,
      undefined,
      {
        moveNear: async (_bot, _target, signal) => {
          actionSignal = signal;
          return new Promise(() => {});
        },
      },
    ),
    /Action timed out/,
  );

  assert.equal(actionSignal.aborted, true);
  assert.equal(stopped, 1);
});

test("runOneCycle does not retry an uncertain action or save it", async () => {
  const bot = fakeBot();
  bot.waitForTicks = async () => {
    bot.waitForTicksCalls += 1;
    throw new Error("connection lost");
  };
  let saves = 0;

  const result = await runOneCycle({
    bot,
    goal,
    jev: { chooseAction: async () => "wait_20_ticks" },
    progressStore: { save: async () => saves++ },
  });

  assert.equal(result.status, "stopped");
  assert.equal(bot.waitForTicksCalls, 1);
  assert.equal(saves, 0);
});

test("runOneCycle does not save a failed postcondition", async () => {
  const bot = fakeBot({ waitTicks: 19 });
  let saves = 0;

  const result = await runOneCycle({
    bot,
    goal,
    jev: { chooseAction: async () => "wait_20_ticks" },
    progressStore: { save: async () => saves++ },
  });

  assert.equal(result.status, "stopped");
  assert.equal(result.reason, "postcondition_failed");
  assert.equal(saves, 0);
});

test("a verified action clears stale victory evidence before checkpointing", async () => {
  const saved = [];
  await runOneCycle({
    bot: fakeBot(),
    goal,
    progress: { victory: "confirmed", actionOutcomes: [] },
    jev: { chooseAction: async () => "wait_20_ticks" },
    progressStore: { save: async value => saved.push(value) },
  });

  assert.equal(saved[0].victory, "unknown");
});

test("runOneCycle passes cancellation to Luna and stops before JEV", async () => {
  const bot = fakeBot();
  const controller = new AbortController();
  let plannerSignal;
  let jevCalls = 0;
  const result = await runOneCycle({
    bot,
    goal,
    signal: controller.signal,
    planner: {
      plan: async ({ signal }) => {
        plannerSignal = signal;
        controller.abort();
        throw new Error("aborted");
      },
    },
    jev: {
      chooseAction: async () => {
        jevCalls += 1;
        return "wait_20_ticks";
      },
    },
    progressStore: { save: async () => assert.fail("saved after abort") },
  });

  assert.equal(plannerSignal, controller.signal);
  assert.equal(result.reason, "aborted");
  assert.equal(jevCalls, 0);
});

test("runOneCycle passes cancellation to JEV and stops before acting", async () => {
  const bot = fakeBot();
  const controller = new AbortController();
  let jevSignal;
  const result = await runOneCycle({
    bot,
    goal,
    signal: controller.signal,
    planner: { plan: async () => goal },
    jev: {
      chooseAction: async ({ signal }) => {
        jevSignal = signal;
        controller.abort();
        throw new Error("aborted");
      },
    },
    progressStore: { save: async () => assert.fail("saved after abort") },
  });

  assert.equal(jevSignal, controller.signal);
  assert.equal(result.reason, "aborted");
  assert.equal(bot.waitForTicksCalls, 0);
});

test("runOneCycle calls Luna before JEV and action execution", async () => {
  const order = [];
  const bot = fakeBot({ onObserve: () => order.push("observe") });
  bot.waitForTicks = async ticks => {
    order.push("execute");
    bot.time.age += ticks;
  };
  const plannedGoal = {
    objective: "Observe before acting",
    successCriteria: ["The bot waits 20 ticks"],
  };
  const progress = { actionOutcomes: [] };
  const result = await runOneCycle({
    bot,
    goal,
    planner: {
      plan: async input => {
        order.push("planner");
        assert.deepEqual(input.progress, progress);
        return plannedGoal;
      },
    },
    jev: {
      chooseAction: async () => {
        order.push("jev");
        return "wait_20_ticks";
      },
    },
    progress,
    progressStore: {
      save: async () => order.push("save"),
    },
  });

  assert.equal(result.goal, plannedGoal);
  assert.deepEqual(order, [
    "observe",
    "planner",
    "jev",
    "observe",
    "execute",
    "observe",
    "save",
  ]);
});

test("runOneCycle stops on an invalid planner goal before JEV", async () => {
  const bot = fakeBot();
  let jevCalls = 0;
  const result = await runOneCycle({
    bot,
    goal,
    planner: {
      plan: async () => ({ objective: "", successCriteria: [] }),
    },
    jev: {
      chooseAction: async () => {
        jevCalls += 1;
        return "wait_20_ticks";
      },
    },
    progressStore: { save: async () => assert.fail("saved invalid goal") },
  });

  assert.equal(result.status, "stopped");
  assert.equal(result.reason, "invalid_goal");
  assert.equal(jevCalls, 0);
  assert.equal(bot.waitForTicksCalls, 0);
});

test("runOneCycle stops on a planner failure before JEV", async () => {
  const bot = fakeBot();
  let jevCalls = 0;
  const result = await runOneCycle({
    bot,
    goal,
    planner: {
      plan: async () => {
        throw new Error("timeout");
      },
    },
    jev: {
      chooseAction: async () => {
        jevCalls += 1;
        return "wait_20_ticks";
      },
    },
    progressStore: { save: async () => assert.fail("saved after planner failure") },
  });

  assert.equal(result.status, "stopped");
  assert.equal(result.reason, "planner_failed");
  assert.equal(jevCalls, 0);
  assert.equal(bot.waitForTicksCalls, 0);
});

test("stopAgent aborts the cycle and disconnects once", async () => {
  const bot = fakeBot();
  const controller = new AbortController();
  await stopAgent({ bot, controller });
  await stopAgent({ bot, controller });

  assert.equal(controller.signal.aborted, true);
  assert.equal(bot.quitCalls, 1);
});
