import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("loadConfig uses the Codex gateway and local Minecraft defaults", () => {
  const config = loadConfig({});

  assert.equal(config.codexBaseUrl, "http://192.168.2.28:2455/backend-api/codex");
  assert.equal(config.codexModel, "gpt-6-luna");
  assert.equal(config.typeSafeBaseUrl, "https://api.typesafe.ai/v1/systemone");
  assert.equal(config.typeSafeModel, "jev-latest");
  assert.equal(config.minecraft.host, "127.0.0.1");
  assert.equal(config.minecraft.port, 25565);
  assert.equal(config.minecraft.version, "1.21.8");
});

test("loadConfig allows read-only use without provider credentials", () => {
  const config = loadConfig({});

  assert.equal(config.codexApiKey, undefined);
  assert.equal(config.typeSafeApiKey, undefined);
});

test("loadConfig requires only the selected provider credential", () => {
  assert.throws(
    () => loadConfig({}, { requiredProvider: "codex" }),
    /CODEX_LB_API_KEY/,
  );
  assert.throws(
    () => loadConfig({}, { requiredProvider: "typesafe" }),
    /TYPESAFE_API_KEY/,
  );

  const config = loadConfig(
    { CODEX_LB_API_KEY: "codex-secret", TYPESAFE_API_KEY: "typesafe-secret" },
    { requiredProvider: "codex" },
  );
  assert.equal(config.codexApiKey, "codex-secret");
});

test("loadConfig rejects an invalid Minecraft port", () => {
  assert.throws(() => loadConfig({ MINECRAFT_PORT: "65536" }), /MINECRAFT_PORT/);
});

test("loadConfig errors never include provider credentials", () => {
  const secret = "fake-secret-for-redaction-test";
  assert.throws(
    () => loadConfig({ CODEX_LB_API_KEY: secret, MINECRAFT_PORT: "invalid" }),
    error => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("loadConfig keeps offline authentication on loopback", () => {
  assert.throws(
    () => loadConfig({ MINECRAFT_HOST: "192.168.1.20" }),
    /MINECRAFT_HOST/,
  );
});
