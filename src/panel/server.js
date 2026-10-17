import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const PAGE = new URL("./index.html", import.meta.url);

function writeJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export async function createDecisionPanel({ port = 8765, onCancel } = {}) {
  const page = await readFile(PAGE);
  const clients = new Set();
  const state = {
    prism: "waiting",
    cycle: "waiting",
    goal: null,
    catalog: [],
    options: [],
    selectedActionId: null,
    probabilities: null,
    execution: null,
    verification: null,
    checkpoint: null,
    result: null,
    observation: null,
    frameRevision: 0,
    timeline: [],
  };
  let frame;

  function broadcast() {
    const message = "data: " + JSON.stringify(state) + "\n\n";
    for (const response of clients) response.write(message);
  }

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": page.length,
      });
      response.end(page);
      return;
    }

    if (request.method === "GET" && request.url === "/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
      });
      response.write("data: " + JSON.stringify(state) + "\n\n");
      clients.add(response);
      response.once("close", () => clients.delete(response));
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/frame.jpg")) {
      if (!frame) {
        response.writeHead(404, { "cache-control": "no-store" });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
        "content-length": frame.length,
      });
      response.end(frame);
      return;
    }

    if (request.method === "POST" && request.url === "/cancel") {
      const port = server.address().port;
      const expectedHosts = new Set([
        `127.0.0.1:${port}`,
        `localhost:${port}`,
        ...(port === 80 ? ["127.0.0.1", "localhost"] : []),
      ]);
      const host = request.headers.host?.toLowerCase();
      if (
        !expectedHosts.has(host) ||
        request.headers.origin !== "http://" + host
      ) {
        writeJson(response, 403, { error: "forbidden" });
        return;
      }
      onCancel?.();
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }

    writeJson(response, 404, { error: "not_found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  function publish(event) {
    if (event?.type === "observation") {
      frame = event.frame;
      state.prism = "connected";
      state.observation = event.observation;
      state.frameRevision = event.frameRevision;
    } else if (event?.type === "cycle") {
      state.cycle = event.status;
    } else if (event?.type === "goal") {
      state.goal = event.goal;
    } else if (event?.type === "options") {
      state.catalog = event.catalog;
      state.options = event.choices;
      state.selectedActionId = null;
      state.probabilities = null;
    } else if (event?.type === "selection") {
      state.selectedActionId = event.selectedId;
      state.probabilities = event.probabilities;
    } else if (event?.type === "execution") {
      state.execution = {
        actionId: event.selectedId,
        status: event.status,
      };
    } else if (event?.type === "verification") {
      state.verification = {
        actionId: event.selectedId,
        status: event.status,
        evidence: event.evidence,
      };
    } else if (event?.type === "checkpoint") {
      state.checkpoint = event.status;
    } else if (event?.type === "result") {
      state.result = event;
      state.cycle = event.status;
    } else if (event?.type === "victory") {
      state.victory = event.status;
    }

    if (event && event.type !== "observation") {
      state.timeline.push(event);
      if (state.timeline.length > 12) state.timeline.shift();
    }
    broadcast();
  }

  return {
    url: "http://127.0.0.1:" + server.address().port + "/",
    publish,
    async close() {
      for (const response of clients) response.end();
      clients.clear();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
