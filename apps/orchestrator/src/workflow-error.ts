const MAX_SERIALIZED_WORKFLOW_ERROR_LENGTH = 2_000;

const serializeObject = (value: object): string => {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, nested) => {
    if (nested instanceof Error)
      return { name: nested.name, message: nested.message };
    if (typeof nested === "bigint") return nested.toString();
    if (typeof nested === "object" && nested !== null) {
      if (seen.has(nested)) return "[Circular]";
      seen.add(nested);
    }
    return nested;
  });
  const message = serialized || "Unknown workflow failure";
  if (message.length <= MAX_SERIALIZED_WORKFLOW_ERROR_LENGTH) return message;
  return `${message.slice(0, MAX_SERIALIZED_WORKFLOW_ERROR_LENGTH - 3)}...`;
};

export const workflowErrorMessage = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (
      "error" in value &&
      ((value as { error?: unknown }).error instanceof Error ||
        typeof (value as { error?: unknown }).error === "string")
    ) {
      return workflowErrorMessage((value as { error: Error | string }).error);
    }
    return serializeObject(value);
  }
  return value == null ? "Unknown workflow failure" : String(value);
};
