import { readFileSync } from "node:fs";
import path from "node:path";

const FREE_THE_END = "minecraft:end/kill_dragon";

function canonicalUuid(value) {
  if (typeof value !== "string") return null;
  const compact = value.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) return null;
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

export function advancementFileFor({ worldDir, playerUuid }) {
  const uuid = canonicalUuid(playerUuid);
  if (!uuid) throw new Error("Invalid player UUID");
  return path.join(worldDir, "advancements", uuid + ".json");
}

export function hasFreeTheEnd({ advancementFile, playerUuid }) {
  const uuid = canonicalUuid(playerUuid);
  if (
    !uuid ||
    typeof advancementFile !== "string" ||
    canonicalUuid(path.basename(advancementFile, ".json")) !== uuid
  ) {
    return false;
  }

  try {
    const record = JSON.parse(readFileSync(advancementFile, "utf8"));
    return record?.[FREE_THE_END]?.done === true;
  } catch {
    return false;
  }
}
