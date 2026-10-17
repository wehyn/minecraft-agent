import { randomUUID } from "node:crypto";
import { ACTION_IDS } from "../actions.js";

const PROTOCOL_VERSION = 1;
const GAME_VERSION = "1.21.8";
const FRAME_LIMIT = 350_000;
const CONNECTION_RETRY_INTERVAL_MS = 500;
const FRAME_INTERVAL_MS = 1000 / 30;
const SESSION_TIMEOUT_MS = 180_000;
const ACTION_STATUSES = new Set([
  "accepted",
  "running",
  "completed",
  "cancelled",
  "failed",
]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("Action aborted"));
    }
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function finitePosition(value) {
  return (
    value &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

function parseSnapshot(value) {
  const hasFrame = value?.frame !== undefined;
  if (
    !value ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !Number.isSafeInteger(value.frameRevision) ||
    value.frameRevision < 1 ||
    typeof value.capturedAt !== "string" ||
    !value.observation ||
    !finitePosition(value.observation.position) ||
    !Number.isFinite(value.observation.eyeHeight) ||
    !Number.isFinite(value.observation.health) ||
    !Number.isFinite(value.observation.food) ||
    !Number.isFinite(value.observation.tick) ||
    !Number.isFinite(value.observation.yaw) ||
    !Number.isFinite(value.observation.pitch) ||
    typeof value.observation.dimension !== "string" ||
    typeof value.observation.difficulty !== "string" ||
    !Array.isArray(value.observation.inventory) ||
    !Array.isArray(value.observation.nearbyBlocks) ||
    !Array.isArray(value.observation.safeMovementTargets) ||
    (hasFrame && typeof value.frame !== "string") ||
    (hasFrame && value.frame.length > FRAME_LIMIT * 2)
  ) {
    throw new Error("Invalid Prism snapshot");
  }

  let frame = null;
  if (hasFrame) {
    frame = Buffer.from(value.frame, "base64");
    if (
      frame.length < 4 ||
      frame.length > FRAME_LIMIT ||
      frame[0] !== 0xff ||
      frame[1] !== 0xd8 ||
      frame.at(-2) !== 0xff ||
      frame.at(-1) !== 0xd9
    ) {
      throw new Error("Invalid Prism frame");
    }
  }

  return {
    sequence: value.sequence,
    frameRevision: value.frameRevision,
    capturedAt: value.capturedAt,
    observation: value.observation,
    frame,
  };
}

export async function connectPrismClient(config, { signal, onSnapshot } = {}) {
  if (!/^[a-f0-9]{64}$/i.test(config?.token || "")) {
    throw new Error("Missing or invalid PRISM_BRIDGE_TOKEN");
  }
  if (config.baseUrl !== "http://127.0.0.1:8766") {
    throw new Error("Invalid Prism bridge URL");
  }

  const headers = {
    accept: "application/json",
    authorization: "Bearer " + config.token,
  };

  async function request(route, {
    method = "GET",
    body,
    requestSignal,
    requestHeaders = {},
  } = {}) {
    let response;
    try {
      response = await fetch(config.baseUrl + route, {
        method,
        headers: {
          ...requestHeaders,
          ...headers,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: requestSignal,
      });
    } catch {
      throw new Error("Prism bridge unavailable");
    }

    const text = await response.text();
    if (text.length > FRAME_LIMIT * 2) throw new Error("Prism response too large");
    let value;
    try {
      value = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("Invalid Prism response");
    }
    if (!response.ok) {
      const error = typeof value.error === "string" ? value.error : "";
      throw new Error(
        error === "not_ready" ? "Prism client is not ready" : "Prism request failed",
      );
    }
    return value;
  }

  let prismSession;
  const sessionDeadline = Date.now() + SESSION_TIMEOUT_MS;
  while (!signal?.aborted && Date.now() < sessionDeadline) {
    try {
      const value = await request("/v1/session", { requestSignal: signal });
      const ids = Array.isArray(value.actionIds) ? value.actionIds : [];
      if (
        value.protocolVersion !== PROTOCOL_VERSION ||
        value.minecraftVersion !== GAME_VERSION ||
        value.connected !== true ||
        typeof value.playerUuid !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.playerUuid) ||
        ids.length !== ACTION_IDS.length ||
        new Set(ids).size !== ACTION_IDS.length ||
        ACTION_IDS.some(id => !ids.includes(id))
      ) {
        if (value.connected === false) {
          await sleep(500, signal);
          continue;
        }
        throw new Error("Incompatible Prism bridge");
      }
      prismSession = {
        protocolVersion: value.protocolVersion,
        minecraftVersion: value.minecraftVersion,
        playerUuid: value.playerUuid,
      };
      break;
    } catch (error) {
      if (signal?.aborted) throw new Error("Prism connection aborted");
      if (error.message === "Incompatible Prism bridge") throw error;
      await sleep(500, signal).catch(() => {});
    }
  }
  if (!prismSession) {
    if (signal?.aborted) throw new Error("Prism connection aborted");
    throw new Error("Prism connection timed out");
  }

  const pollController = new AbortController();
  const stopPolling = () => pollController.abort();
  signal?.addEventListener("abort", stopPolling, { once: true });
  let latest;
  let closed = false;
  let activeCommandId;
  const waiters = new Set();

  function settleWaiters(snapshot, restarted) {
    for (const waiter of waiters) {
      if (!restarted && snapshot.sequence <= waiter.after) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.resolve(snapshot);
    }
  }

  function acceptSnapshot(snapshot) {
    // shortcut: both counters must reset together, use a session ID if they can reset independently.
    const restarted = Boolean(
      latest &&
      snapshot.sequence < latest.sequence &&
      snapshot.frameRevision < latest.frameRevision
    );
    if (latest && snapshot.frameRevision < latest.frameRevision && !restarted) return;
    if (latest && !snapshot.frame) {
      if (restarted || snapshot.frameRevision !== latest.frameRevision) {
        throw new Error("Missing Prism frame");
      }
      snapshot.frame = latest.frame;
    }
    if (!snapshot.frame) throw new Error("Missing Prism frame");
    if (
      latest && !restarted &&
      snapshot.sequence <= latest.sequence &&
      snapshot.frameRevision <= latest.frameRevision
    ) return;
    latest = snapshot;
    try {
      onSnapshot?.(snapshot);
    } catch {}
    settleWaiters(snapshot, restarted);
  }

  async function readSnapshot(requestSignal) {
    const value = await request("/v1/snapshot", {
      requestSignal,
      requestHeaders: latest
        ? { "x-after-frame-revision": String(latest.frameRevision) }
        : {},
    });
    return parseSnapshot(value);
  }

  while (!signal?.aborted && Date.now() < sessionDeadline && !latest) {
    try {
      acceptSnapshot(await readSnapshot(signal));
    } catch (error) {
      if (signal?.aborted) throw new Error("Prism connection aborted");
      await sleep(CONNECTION_RETRY_INTERVAL_MS, signal).catch(() => {});
    }
  }
  if (!latest) throw new Error("Prism connection timed out");

  async function poll() {
    let deadline = performance.now();
    while (!pollController.signal.aborted) {
      try {
        acceptSnapshot(await readSnapshot(pollController.signal));
      } catch {
        if (pollController.signal.aborted) break;
      }
      deadline += FRAME_INTERVAL_MS;
      const now = performance.now();
      if (deadline < now) deadline = now;
      await sleep(deadline - now, pollController.signal).catch(() => {});
    }
  }

  const pollTask = poll();

  function snapshot({ after, signal: requestSignal } = {}) {
    if (closed) return Promise.reject(new Error("Prism client closed"));
    if (after === undefined || latest.sequence > after) return Promise.resolve(latest);
    return new Promise((resolve, reject) => {
      const waiter = {
        after,
        signal: requestSignal,
        resolve,
        reject,
        abort: () => {
          waiters.delete(waiter);
          clearTimeout(waiter.timer);
          reject(new Error("Prism snapshot aborted"));
        },
        timer: setTimeout(() => {
          waiters.delete(waiter);
          requestSignal?.removeEventListener("abort", waiter.abort);
          reject(new Error("Prism snapshot timed out"));
        }, 30_000),
      };
      if (requestSignal?.aborted) return waiter.abort();
      requestSignal?.addEventListener("abort", waiter.abort, { once: true });
      waiters.add(waiter);
      if (latest.sequence > after) settleWaiters(latest);
    });
  }

  async function cancelCommand(commandId) {
    if (!commandId) return;
    await request("/v1/action/" + commandId + "/cancel", {
      method: "POST",
      body: {},
    }).catch(() => {});
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const receipt = await request("/v1/action/" + commandId).catch(() => null);
      if (
        receipt?.controlsReleased === true ||
        ["completed", "cancelled", "failed"].includes(receipt?.status)
      ) return;
      await sleep(100).catch(() => {});
    }
  }

  async function execute(candidate, {
    basedOnSequence,
    signal: actionSignal,
    onStatus,
  } = {}) {
    if (closed || activeCommandId) throw new Error("Prism action unavailable");
    const commandId = randomUUID();
    activeCommandId = commandId;
    const action = { id: candidate.id, timeoutMs: candidate.timeoutMs };
    if (candidate.startTick !== undefined) action.startTick = candidate.startTick;
    if (candidate.target) action.target = candidate.target;
    if (candidate.radius !== undefined) action.radius = candidate.radius;

    try {
      const accepted = await request("/v1/action", {
        method: "POST",
        body: { commandId, basedOnSequence, action },
        requestSignal: actionSignal,
      });
      if (accepted.commandId !== commandId) throw new Error("Invalid Prism receipt");
      onStatus?.("accepted");

      while (true) {
        const receipt = await request("/v1/action/" + commandId, {
          requestSignal: actionSignal,
        });
        if (
          receipt.commandId !== commandId ||
          !ACTION_STATUSES.has(receipt.status)
        ) {
          throw new Error("Invalid Prism receipt");
        }
        onStatus?.(receipt.status);
        if (receipt.status === "completed") return;
        if (receipt.status === "cancelled") throw new Error("Action aborted");
        if (receipt.status === "failed") {
          throw new Error(
            receipt.reason === "timeout" ? "Action timed out" : "Action failed",
          );
        }
        await sleep(100, actionSignal);
      }
    } catch (error) {
      if (actionSignal?.aborted) {
        await cancelCommand(commandId);
        onStatus?.("cancelled");
        throw new Error("Action aborted");
      }
      throw error;
    } finally {
      activeCommandId = undefined;
    }
  }

  return {
    session: prismSession,
    snapshot,
    execute,
    cancelAction: () => cancelCommand(activeCommandId),
    async close() {
      if (closed) return;
      closed = true;
      await cancelCommand(activeCommandId);
      pollController.abort();
      signal?.removeEventListener("abort", stopPolling);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener("abort", waiter.abort);
        waiter.reject(new Error("Prism client closed"));
      }
      waiters.clear();
      await pollTask;
    },
  };
}
