import path from "node:path";

const DEFAULT_CODEX_BASE_URL = "http://192.168.2.28:2455/backend-api/codex";
const DEFAULT_TYPESAFE_BASE_URL = "https://api.typesafe.ai/v1/systemone";

function apiUrl(value, variable) {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error("Invalid " + variable);
  }
}

function portValue(value) {
  if (!/^\d+$/.test(String(value ?? "25565"))) {
    throw new Error("Invalid MINECRAFT_PORT");
  }
  const port = Number(value ?? 25565);
  if (port < 1 || port > 65535) throw new Error("Invalid MINECRAFT_PORT");
  return port;
}

function panelPortValue(value) {
  if (!/^\d+$/.test(String(value ?? "8765"))) throw new Error("Invalid PANEL_PORT");
  const port = Number(value ?? 8765);
  if (port < 1 || port > 65535) throw new Error("Invalid PANEL_PORT");
  return port;
}

export function loadConfig(env = process.env, { requiredProvider } = {}) {
  if (requiredProvider !== undefined && !["codex", "typesafe"].includes(requiredProvider)) {
    throw new Error("Invalid required provider");
  }

  const codexApiKey = env.CODEX_LB_API_KEY || undefined;
  const typeSafeApiKey = env.TYPESAFE_API_KEY || undefined;
  if (requiredProvider === "codex" && !codexApiKey) {
    throw new Error("Missing CODEX_LB_API_KEY");
  }
  if (requiredProvider === "typesafe" && !typeSafeApiKey) {
    throw new Error("Missing TYPESAFE_API_KEY");
  }

  const host = env.MINECRAFT_HOST || "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("MINECRAFT_HOST must be 127.0.0.1");

  const runtimeDir = path.resolve(env.RUNTIME_DIR || "runtime");
  return {
    codexBaseUrl: apiUrl(
      env.CODEX_LB_BASE_URL || DEFAULT_CODEX_BASE_URL,
      "CODEX_LB_BASE_URL",
    ),
    codexModel: env.CODEX_LB_MODEL || "gpt-6-luna",
    codexApiKey,
    typeSafeBaseUrl: apiUrl(
      env.TYPESAFE_BASE_URL || DEFAULT_TYPESAFE_BASE_URL,
      "TYPESAFE_BASE_URL",
    ),
    typeSafeModel: env.TYPESAFE_MODEL || "jev-latest",
    typeSafeApiKey,
    runtimeDir,
    progressFile: path.join(runtimeDir, "progress.json"),
    prism: {
      baseUrl: "http://127.0.0.1:8766",
      token: env.PRISM_BRIDGE_TOKEN || undefined,
    },
    panelPort: panelPortValue(env.PANEL_PORT),
    minecraft: {
      host,
      port: portValue(env.MINECRAFT_PORT),
      version: env.MINECRAFT_VERSION || "1.21.8",
      username: env.MINECRAFT_USERNAME || "MinecraftAgent",
      auth: "offline",
      serverDir: path.join(runtimeDir, "server"),
      worldDir: path.join(runtimeDir, "server", "world"),
    },
  };
}
