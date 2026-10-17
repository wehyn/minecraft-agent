import { loadConfig } from "../src/config.js";
import { createJevProvider } from "../src/providers/typesafe-jev.js";

try {
  const config = loadConfig(process.env, { requiredProvider: "typesafe" });
  const jev = createJevProvider({ config });
  await jev.chooseAction({
    observation: { dimension: "overworld", health: 20, food: 20, tick: 100 },
    goal: {
      objective: "Wait safely",
      successCriteria: ["Observe at least 20 game ticks"],
    },
    candidates: [{ id: "wait_20_ticks", description: "Wait for 20 game ticks" }],
  });
  console.log("TypeSafe JEV preflight passed.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
