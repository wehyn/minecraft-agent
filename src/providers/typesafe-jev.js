const REQUEST_TIMEOUT_MS = 15_000;

function offeredChoices(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("Invalid TypeSafe action candidates");
  }

  const choices = candidates.map(({ id, description }) => ({ id, description }));
  if (
    choices.some(
      choice =>
        typeof choice.id !== "string" ||
        !choice.id ||
        typeof choice.description !== "string" ||
        !choice.description,
    ) ||
    new Set(choices.map(choice => choice.id)).size !== choices.length
  ) {
    throw new Error("Invalid TypeSafe action candidates");
  }
  return choices;
}

function validatedProbabilities(value, choices) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const ids = choices.map(({ id }) => id);
  const keys = Object.keys(value);
  if (keys.length !== ids.length || keys.some(id => !ids.includes(id))) return null;
  const probabilities = Object.fromEntries(ids.map(id => [id, value[id]]));
  const values = Object.values(probabilities);
  if (values.some(score => !Number.isFinite(score) || score < 0 || score > 1)) return null;
  if (Math.abs(values.reduce((sum, score) => sum + score, 0) - 1) > 0.01) return null;
  return probabilities;
}

export function createJevProvider({
  config,
  fetchImpl = fetch,
  timeoutSignal = milliseconds => AbortSignal.timeout(milliseconds),
}) {
  return {
    async chooseAction({ observation, goal, candidates, signal, onDecision }) {
      if (!config.typeSafeApiKey) throw new Error("Missing TYPESAFE_API_KEY");
      if (signal?.aborted) throw new Error("TypeSafe request failed");
      const choices = offeredChoices(candidates);
      const criteria = Object.fromEntries(
        choices.map(({ id, description }) => [id, description]),
      );

      let result;
      try {
        const response = await fetchImpl(config.typeSafeBaseUrl, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + config.typeSafeApiKey,
            "Content-Type": "application/json",
          },
          signal: signal
            ? AbortSignal.any([timeoutSignal(REQUEST_TIMEOUT_MS), signal])
            : timeoutSignal(REQUEST_TIMEOUT_MS),
          body: JSON.stringify({
            model: config.typeSafeModel,
            state: { observation, goal },
            questions: {
              action: {
                type: "choice",
                instructions: "Choose the single safest action that advances the goal.",
                criteria,
              },
            },
          }),
        });
        if (!response.ok) throw new Error("TypeSafe HTTP error");
        result = await response.json();
      } catch {
        throw new Error("TypeSafe request failed");
      }

      const answer = result?.answers?.action;
      if (
        answer?.type !== "choice" ||
        typeof answer.choice !== "string" ||
        !choices.some(choice => choice.id === answer.choice)
      ) {
        throw new Error("Invalid TypeSafe action choice");
      }
      try {
        onDecision?.({
          selectedId: answer.choice,
          probabilities: validatedProbabilities(answer.probabilities, choices),
        });
      } catch {
      }
      return answer.choice;
    },
  };
}
