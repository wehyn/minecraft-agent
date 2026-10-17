export function isValidGoal(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    typeof value.objective === "string" &&
    value.objective.trim().length > 0 &&
    value.objective.length <= 240 &&
    Array.isArray(value.successCriteria) &&
    value.successCriteria.length >= 1 &&
    value.successCriteria.length <= 3 &&
    value.successCriteria.every(
      criterion =>
        typeof criterion === "string" &&
        criterion.trim().length > 0 &&
        criterion.length <= 200,
    )
  );
}
