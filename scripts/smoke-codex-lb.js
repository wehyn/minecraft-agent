import { loadConfig } from "../src/config.js";
import { createCodexClient, createPlanner } from "../src/providers/codex-lb.js";

try {
  const config = loadConfig(process.env, { requiredProvider: "codex" });
  const planner = createPlanner({ config, client: createCodexClient(config) });
  await planner.plan({
    observation: { dimension: "overworld", health: 20, food: 20, tick: 100 },
    progress: {},
  });
  console.log("Codex-LB preflight passed.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
