import { loadConfig } from "../src/config.js";
import { connectPrismClient } from "../src/minecraft/prism-client.js";

let client;
try {
  client = await connectPrismClient(loadConfig().prism);
  const snapshot = await client.snapshot();
  const state = snapshot.observation;
  console.log(JSON.stringify({
    minecraftVersion: client.session.minecraftVersion,
    position: state.position,
    dimension: state.dimension,
    health: state.health,
    food: state.food,
    difficulty: state.difficulty,
    tick: state.tick,
    nearbyBlocks: state.nearbyBlocks.length,
    povBytes: snapshot.frame.length,
  }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (client) await client.close();
}
