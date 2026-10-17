import { loadConfig } from "../src/config.js";
import { connectBot, disconnect, observe } from "../src/minecraft/bot.js";

let bot;
try {
  bot = await connectBot(loadConfig());
  const state = observe(bot);
  console.log(
    JSON.stringify({
      position: state.position,
      dimension: state.dimension,
      health: state.health,
      food: state.food,
      difficulty: state.difficulty,
      inventory: state.inventory,
      tick: state.tick,
      nearbyBlocks: state.nearbyBlocks.length,
    }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (bot) await disconnect(bot);
}
