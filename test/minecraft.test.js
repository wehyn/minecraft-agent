import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import {
  connectBot,
  disconnect,
  observe,
} from "../src/minecraft/bot.js";

function fakeBot() {
  const bot = new EventEmitter();
  const positions = [];
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) positions.push({ x, y: 64, z });
  }
  bot.entity = {
    position: { x: 0, y: 64, z: 0 },
    eyeHeight: 1.62,
    yaw: 0.25,
    pitch: -0.1,
  };
  bot.game = { dimension: "overworld", difficulty: "normal" };
  bot.health = 20;
  bot.food = 20;
  bot.inventory = { items: () => [] };
  bot.time = { age: 100 };
  bot.findBlocks = options => {
    bot.searchOptions = options;
    return positions;
  };
  bot.blockAt = position => ({ name: "stone", position });
  bot.waitForChunksToLoad = async () => {
    bot.chunksLoaded = true;
  };
  bot.quitCalls = 0;
  bot.quit = () => {
    bot.quitCalls += 1;
    bot.emit("end", "quit");
  };
  return bot;
}

test("observe returns normalized state with at most 16 blocks within eight blocks", () => {
  const bot = fakeBot();
  const state = observe(bot);

  assert.deepEqual(state.position, { x: 0, y: 64, z: 0 });
  assert.equal(state.eyeHeight, 1.62);
  assert.equal(state.dimension, "overworld");
  assert.equal(state.health, 20);
  assert.equal(state.food, 20);
  assert.equal(state.difficulty, "normal");
  assert.equal(state.tick, 100);
  assert.equal(state.nearbyBlocks.length, 16);
  assert.equal(bot.searchOptions.maxDistance, 8);
  assert.equal(bot.searchOptions.count, 16);
  assert.ok(
    state.nearbyBlocks.every(block => {
      const { x, y, z } = block.position;
      return Math.hypot(x, y - 64, z) <= 8;
    }),
  );
});

test("observe omits chat and credentials", () => {
  const bot = fakeBot();
  bot.chatHistory = ["private message"];
  bot.apiKey = "fake-secret";

  const serialized = JSON.stringify(observe(bot));
  assert.doesNotMatch(serialized, /private message|fake-secret|chatHistory|apiKey/);
});

test("observe rejects missing required game state", () => {
  const bot = fakeBot();
  bot.health = undefined;

  assert.throws(() => observe(bot), /Invalid Minecraft observation/);
});

test("connect waits for spawn and chunks with loopback offline settings", async () => {
  const bot = fakeBot();
  let options;
  const connecting = connectBot(loadConfig({}), {
    mineflayerImpl: {
      createBot(value) {
        options = value;
        return bot;
      },
    },
    connectTimeoutMs: 100,
  });

  assert.equal(bot.chunksLoaded, undefined);
  bot.emit("spawn");
  assert.equal(await connecting, bot);
  assert.equal(bot.chunksLoaded, true);
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.port, 25565);
  assert.equal(options.version, "1.21.8");
  assert.equal(options.auth, "offline");
});

test("connect rejects when spawn does not arrive before the timeout", async () => {
  const bot = fakeBot();

  await assert.rejects(
    connectBot(loadConfig({}), {
      mineflayerImpl: { createBot: () => bot },
      connectTimeoutMs: 5,
    }),
    /Minecraft spawn timed out/,
  );
});

test("connect rejects a connection error without exposing its message", async () => {
  const bot = fakeBot();
  const connecting = connectBot(loadConfig({}), {
    mineflayerImpl: {
      createBot() {
        queueMicrotask(() => bot.emit("error", new Error("fake-secret")));
        return bot;
      },
    },
    connectTimeoutMs: 100,
  });

  await assert.rejects(connecting, error => {
    assert.doesNotMatch(error.message, /fake-secret/);
    return true;
  });
});

test("disconnect quits once and resolves after the bot ends", async () => {
  const bot = fakeBot();

  await Promise.all([disconnect(bot), disconnect(bot)]);
  assert.equal(bot.quitCalls, 1);
});
