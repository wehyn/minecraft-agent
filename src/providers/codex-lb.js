import OpenAI from "openai";
import { isValidGoal } from "../goal.js";

const REQUEST_TIMEOUT_MS = 60_000;

function parseGoal(outputText) {
  let value;
  try {
    value = JSON.parse(outputText);
  } catch {
    throw new Error("Invalid Codex-LB goal");
  }

  if (!isValidGoal(value)) throw new Error("Invalid Codex-LB goal");

  return {
    objective: value.objective,
    successCriteria: [...value.successCriteria],
  };
}

export function createCodexClient(config) {
  if (!config.codexApiKey) throw new Error("Missing CODEX_LB_API_KEY");
  return new OpenAI({
    apiKey: config.codexApiKey,
    baseURL: config.codexBaseUrl,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  });
}

export function createPlanner({ config, client = createCodexClient(config) }) {
  return {
    async plan({ observation, progress, signal }) {
      let outputText = "";
      let completed = false;
      try {
        if (signal?.aborted) throw new Error();
        const responseStream = await client.responses.create(
          {
            model: config.codexModel,
            reasoning: { effort: "max" },
            service_tier: "default",
            stream: true,
            input: [
              "Return one JSON object with exactly objective and successCriteria.",
              "Do not include actions, action names, parameters, coordinates, or code.",
              "Keep the objective to 1-240 characters and successCriteria to 1-3 strings of 1-200 characters each.",
              JSON.stringify({ observation, progress }),
            ].join("\n"),
          },
          { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0, signal },
        );
        for await (const event of responseStream) {
          if (event?.type === "response.output_text.delta") {
            if (typeof event.delta !== "string") throw new Error();
            outputText += event.delta;
          } else if (event?.type === "response.completed") {
            completed = true;
          } else if (
            ["response.failed", "response.incomplete", "error"].includes(event?.type)
          ) {
            throw new Error();
          }
        }
        if (!completed) throw new Error();
      } catch {
        throw new Error("Codex-LB request failed");
      }
      return parseGoal(outputText);
    },
  };
}
