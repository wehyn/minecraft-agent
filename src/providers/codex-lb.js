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
      let response;
      try {
        if (signal?.aborted) throw new Error();
        response = await client.responses.create(
          {
            model: config.codexModel,
            reasoning: { effort: "max" },
            service_tier: "default",
            input: [
              "Return one JSON object with exactly objective and successCriteria.",
              "Do not include actions, action names, parameters, coordinates, or code.",
              "Keep the objective to 1-240 characters and successCriteria to 1-3 strings of 1-200 characters each.",
              JSON.stringify({ observation, progress }),
            ].join("\n"),
          },
          { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0, signal },
        );
      } catch {
        throw new Error("Codex-LB request failed");
      }
      return parseGoal(response?.output_text);
    },
  };
}
