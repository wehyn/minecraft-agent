import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import {
  advancementFileFor,
  hasFreeTheEnd,
} from "./advancement.js";
import { runOneCycle, stopAgent } from "./agent.js";
import { loadProgress, saveProgress } from "./progress.js";
import { connectPrismClient } from "./minecraft/prism-client.js";
import { createDecisionPanel } from "./panel/server.js";
import { createCodexClient, createPlanner } from "./providers/codex-lb.js";
import { createJevProvider } from "./providers/typesafe-jev.js";

const SAFE_ERRORS = new Set([
  "Missing CODEX_LB_API_KEY",
  "Missing TYPESAFE_API_KEY",
  "Missing or invalid PRISM_BRIDGE_TOKEN",
  "Invalid progress file",
  "Invalid progress record",
  "Progress file unavailable",
  "Progress save failed",
  "Invalid player UUID",
  "Invalid CODEX_LB_BASE_URL",
  "Invalid TYPESAFE_BASE_URL",
  "Invalid required provider",
  "Incompatible Prism bridge",
  "Prism connection aborted",
  "Prism connection timed out",
  "Prism bridge unavailable",
]);

function safeError(error) {
  return SAFE_ERRORS.has(error?.message)
    ? error.message
    : "Agent stopped.";
}

function waitForStop(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    signal.addEventListener("abort", resolve, { once: true });
  });
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

  const panel = await createDecisionPanel({
    port: config.panelPort,
    onCancel: () => controller.abort(),
  });
  console.log("Decision panel: " + panel.url);

  let driver;
  let checkpoint;
  let result;
  try {
    driver = await connectPrismClient(config.prism, {
      signal: controller.signal,
      onSnapshot: snapshot => panel.publish({
        type: "observation",
        sequence: snapshot.sequence,
        frameRevision: snapshot.frameRevision,
        observation: snapshot.observation,
        frame: snapshot.frame,
      }),
    });
    const initial = await driver.snapshot({ signal: controller.signal });
    const startedAt = progress.run.startedAt || new Date().toISOString();
    const run = {
      ...progress.run,
      minecraftVersion: driver.session.minecraftVersion,
      difficulty: progress.run.difficulty || initial.observation.difficulty,
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
      driver,
      planner,
      jev,
      progress: currentProgress,
      progressStore,
      signal: controller.signal,
      publish: event => panel.publish(event),
    });

    if (result.status === "verified") {
      let victory = "unknown";
      try {
        const advancementFile = advancementFileFor({
          worldDir: config.minecraft.worldDir,
          playerUuid: driver.session.playerUuid,
        });
        if (hasFreeTheEnd({ advancementFile, playerUuid: driver.session.playerUuid })) {
          victory = "confirmed";
          checkpoint = { ...checkpoint, victory };
          await saveProgress(config.progressFile, checkpoint).catch(() => {});
        }
      } catch {
        victory = "unknown";
      }
      panel.publish({ type: "victory", status: victory });
      result = { ...result, victory };
    }

    console.log(JSON.stringify({
      status: result.status,
      actionId: result.actionId,
      reason: result.reason,
      victory: result.victory,
    }));
    await waitForStop(controller.signal);
    return result;
  } finally {
    await stopAgent({ driver, controller });
    await panel.close();
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "smoke:agent")) {
    console.error("Run one Prism cycle with: npm start");
    process.exitCode = 2;
    return;
  }

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const result = await runAgent({ controller });
    if (result.status !== "verified") process.exitCode = 1;
  } catch (error) {
    console.error(safeError(error));
    process.exitCode = 1;
    controller.abort();
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
