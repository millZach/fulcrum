export const api = async <T>(
  path: string,
  options?: RequestInit,
): Promise<T> => {
  const headers = new Headers(options?.headers);
  if (options?.body != null && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const payload = (await response.json()) as T & { detail?: string };
  if (!response.ok)
    throw new Error(payload.detail ?? `Request failed (${response.status}).`);
  return payload;
};
