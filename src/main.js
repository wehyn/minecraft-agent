import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import {
  advancementFileFor,
  hasFreeTheEnd,
} from "./advancement.js";
import { runOneCycle, stopAgent } from "./agent.js";
import { loadProgress, saveProgress } from "./progress.js";
import { connectBot, observe } from "./minecraft/bot.js";
import { createCodexClient, createPlanner } from "./providers/codex-lb.js";
import { createJevProvider } from "./providers/typesafe-jev.js";

const SAFE_ERRORS = new Set([
  "Missing CODEX_LB_API_KEY",
  "Missing TYPESAFE_API_KEY",
  "Invalid progress file",
  "Invalid progress record",
  "Progress file unavailable",
  "Progress save failed",
  "Invalid player UUID",
  "Invalid MINECRAFT_PORT",
  "MINECRAFT_HOST must be 127.0.0.1",
  "Invalid CODEX_LB_BASE_URL",
  "Invalid TYPESAFE_BASE_URL",
  "Invalid required provider",
  "Minecraft connection failed",
  "Minecraft spawn timed out",
  "Minecraft chunk load timed out",
]);

function safeError(error) {
  return SAFE_ERRORS.has(error?.message)
    ? error.message
    : "Agent stopped.";
}

export async function runAgent({
  env = process.env,
  controller = new AbortController(),
} = {}) {
  const config = loadConfig(env, { requiredProvider: "codex" });
  if (!config.typeSafeApiKey) throw new Error("Missing TYPESAFE_API_KEY");

  const planner = createPlanner({
    config,
    client: createCodexClient(config),
  });
  const jev = createJevProvider({ config });
  const progress = await loadProgress(config.progressFile);
  if (
    progress.run.minecraftVersion &&
    progress.run.minecraftVersion !== config.minecraft.version
  ) {
    throw new Error("Invalid progress record");
  }

  let bot;
  let checkpoint;
  let result;
  try {
    bot = await connectBot(config, { signal: controller.signal });
    const observation = observe(bot);
    const startedAt = progress.run.startedAt || new Date().toISOString();
    const run = {
      ...progress.run,
      minecraftVersion: config.minecraft.version,
      difficulty: progress.run.difficulty || observation.difficulty,
      startedAt,
    };
    const currentProgress = { ...progress, run };
    const startedAtMs = Date.parse(startedAt);
    const progressStore = {
      async save(nextProgress) {
        const elapsedMs = Math.max(
          nextProgress.run.elapsedMs,
          Date.now() - startedAtMs,
        );
        checkpoint = {
          ...nextProgress,
          run: { ...nextProgress.run, elapsedMs },
        };
        await saveProgress(config.progressFile, checkpoint);
      },
    };

    result = await runOneCycle({
      bot,
      planner,
      jev,
      progress: currentProgress,
      progressStore,
      signal: controller.signal,
    });
  } finally {
    await stopAgent({ bot, controller });
  }

  if (result.status !== "verified") return result;

  let victory = "unknown";
  try {
    const advancementFile = advancementFileFor({
      worldDir: config.minecraft.worldDir,
      playerUuid: bot.player.uuid,
    });
    if (hasFreeTheEnd({ advancementFile, playerUuid: bot.player.uuid })) {
      victory = "confirmed";
      checkpoint = { ...checkpoint, victory };
      await saveProgress(config.progressFile, checkpoint).catch(() => {});
    }
  } catch {
    victory = "unknown";
  }
  return { ...result, victory };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "smoke:agent")) {
    console.error("Run one cycle with: npm run smoke:agent");
    process.exitCode = 2;
    return;
  }

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const result = await runAgent({ controller });
    if (result.status !== "verified") {
      console.error("Agent stopped: " + result.reason);
      process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify({
        status: result.status,
        actionId: result.actionId,
        victory: result.victory,
      }),
    );
  } catch (error) {
    console.error(safeError(error));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  await main();
}
