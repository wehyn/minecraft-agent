import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createCodexClient, createPlanner } from "../src/providers/codex-lb.js";
import { createJevProvider } from "../src/providers/typesafe-jev.js";

const observation = {
  position: { x: 0, y: 64, z: 0 },
  dimension: "overworld",
  health: 20,
  food: 20,
  difficulty: "normal",
  inventory: [],
  tick: 100,
  yaw: 0,
  pitch: 0,
  nearbyBlocks: [],
};

const goal = {
  objective: "Wait safely",
  successCriteria: ["Observe at least 20 game ticks"],
};

const choice = {
  id: "wait_20_ticks",
  description: "Wait for 20 game ticks",
  parameters: { ticks: 20 },
};

async function* responseEvents(events) {
  yield* events;
}

test("Codex-LB client disables SDK retries and sets the request timeout", () => {
  const config = loadConfig({ CODEX_LB_API_KEY: "codex-test-key" });
  const client = createCodexClient(config);

  assert.equal(client.baseURL, config.codexBaseUrl);
  assert.equal(client.maxRetries, 0);
  assert.equal(client.timeout, 60_000);
});

test("planner returns a bounded goal and sends one bounded Responses request", async () => {
  let request;
  let options;
  const outputText =
    '{"objective":"Wait safely","successCriteria":["Observe at least 20 game ticks"]}';
  const client = {
    responses: {
      create: async (body, requestOptions) => {
        request = body;
        options = requestOptions;
        return responseEvents([
          { type: "response.output_text.delta", delta: outputText },
          { type: "response.metadata" },
          { type: "response.completed" },
        ]);
      },
    },
  };
  const config = loadConfig({ CODEX_LB_API_KEY: "codex-test-key" });
  const planner = createPlanner({ config, client });

  assert.deepEqual(await planner.plan({ observation, progress: {} }), goal);
  assert.equal(request.model, "gpt-6-luna");
  assert.equal(request.stream, true);
  assert.deepEqual(request.reasoning, { effort: "max" });
  assert.equal(request.service_tier, "default");
  assert.equal(options.timeout, 60_000);
  assert.equal(options.maxRetries, 0);
});

test("planner rejects malformed and action-bearing output", async () => {
  for (const output_text of [
    "not json",
    '{"objective":"","successCriteria":["No objective"]}',
    '{"objective":"Wait","successCriteria":["Done"],"action":"break_block"}',
  ]) {
    const planner = createPlanner({
      config: loadConfig({ CODEX_LB_API_KEY: "codex-test-key" }),
      client: {
        responses: {
          create: async () => responseEvents([
            { type: "response.output_text.delta", delta: output_text },
            { type: "response.completed" },
          ]),
        },
      },
    });
    await assert.rejects(
      planner.plan({ observation, progress: {} }),
      /Invalid Codex-LB goal/,
    );
  }
});

test("planner cancels an in-flight request when the cycle is aborted", async () => {
  const controller = new AbortController();
  let requestSignal;
  const planner = createPlanner({
    config: loadConfig({ CODEX_LB_API_KEY: "codex-test-key" }),
    client: {
      responses: {
        create: async (_body, options) => {
          requestSignal = options.signal;
          return {
            async *[Symbol.asyncIterator]() {
              if (options.signal.aborted) throw new Error("aborted");
              await new Promise((_resolve, reject) => {
                options.signal.addEventListener(
                  "abort",
                  () => reject(new Error("aborted")),
                  { once: true },
                );
              });
            },
          };
        },
      },
    },
  });

  const pending = planner.plan({ observation, progress: {}, signal: controller.signal });
  controller.abort();

  await assert.rejects(pending, /Codex-LB request failed/);
  assert.equal(requestSignal, controller.signal);
});

test("JEV sends only offered choice projections and returns an offered ID", async () => {
  let url;
  let options;
  const provider = createJevProvider({
    config: loadConfig({ TYPESAFE_API_KEY: "typesafe-test-key" }),
    fetchImpl: async (requestUrl, requestOptions) => {
      url = requestUrl;
      options = requestOptions;
      return {
        ok: true,
        json: async () => ({
          model: "jev-latest",
          answers: {
            action: {
              type: "choice",
              choice: "wait_20_ticks",
              confidence: 0.9,
              probabilities: { wait_20_ticks: 0.9, look_at_observed_block: 0.1 },
            },
          },
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      };
    },
  });

  const selected = await provider.chooseAction({
    observation,
    goal,
    candidates: [choice],
  });

  const body = JSON.parse(options.body);
  assert.equal(selected, "wait_20_ticks");
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(options.method, "POST");
  assert.equal(options.headers.Authorization, "Bearer typesafe-test-key");
  assert.deepEqual(body.questions.action.criteria, {
    wait_20_ticks: "Wait for 20 game ticks",
  });
  assert.deepEqual(body.state, { observation, goal });
  assert.ok(options.signal instanceof AbortSignal);
});

test("JEV rejects a choice that was not offered", async () => {
  const provider = createJevProvider({
    config: loadConfig({ TYPESAFE_API_KEY: "typesafe-test-key" }),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        answers: {
          action: {
            type: "choice",
            choice: "break_block",
            confidence: 0.9,
            probabilities: { break_block: 1 },
          },
        },
      }),
    }),
  });

  await assert.rejects(
    provider.chooseAction({ observation, goal, candidates: [choice] }),
    /Invalid TypeSafe action choice/,
  );
});

test("JEV cancels an in-flight request when the cycle is aborted", async () => {
  const controller = new AbortController();
  let requestSignal;
  const provider = createJevProvider({
    config: loadConfig({ TYPESAFE_API_KEY: "typesafe-test-key" }),
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    },
  });

  const pending = provider.chooseAction({
    observation,
    goal,
    candidates: [choice],
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(pending, /TypeSafe request failed/);
  assert.equal(requestSignal.aborted, true);
});

test("provider failures redact fake credentials", async () => {
  const secret = "provider-fake-secret";
  const planner = createPlanner({
    config: loadConfig({ CODEX_LB_API_KEY: secret }),
    client: {
      responses: {
        create: async () => {
          throw new Error("request included " + secret);
        },
      },
    },
  });
  await assert.rejects(
    planner.plan({ observation, progress: {} }),
    error => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );

  const jev = createJevProvider({
    config: loadConfig({ TYPESAFE_API_KEY: secret }),
    fetchImpl: async () => {
      throw new Error("request included " + secret);
    },
  });
  await assert.rejects(
    jev.chooseAction({ observation, goal, candidates: [choice] }),
    error => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("Codex-LB timeout errors fail closed", async () => {
  const planner = createPlanner({
    config: loadConfig({ CODEX_LB_API_KEY: "codex-test-key" }),
    client: {
      responses: {
        create: async () => {
          throw new Error("timeout");
        },
      },
    },
  });

  await assert.rejects(
    planner.plan({ observation, progress: {} }),
    /Codex-LB request failed/,
  );
});

test("TypeSafe timeout errors fail closed after requesting a 15-second signal", async () => {
  const timeoutMs = [];
  const provider = createJevProvider({
    config: loadConfig({ TYPESAFE_API_KEY: "typesafe-test-key" }),
    timeoutSignal: milliseconds => {
      timeoutMs.push(milliseconds);
      return AbortSignal.abort(new Error("timeout"));
    },
    fetchImpl: async () => {
      throw new Error("timeout");
    },
  });

  await assert.rejects(
    provider.chooseAction({ observation, goal, candidates: [choice] }),
    /TypeSafe request failed/,
  );
  assert.deepEqual(timeoutMs, [15_000]);
});
