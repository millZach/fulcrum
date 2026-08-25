export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = message;
    if (code !== undefined) this.code = code;
  }
}

export const isApiError = (error: unknown): error is ApiError =>
  error instanceof ApiError;

export const fetchArtifactJson = async (uri: string): Promise<unknown> => {
  const response = await fetch(uri);
  if (!response.ok)
    throw new ApiError(
      `Artifact request failed with ${response.status}.`,
      response.status,
    );
  return response.json();
};

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
  const payload = (await response.json()) as T & {
    detail?: string;
    error?: string;
    code?: string;
  };
  if (!response.ok) {
    const message =
      payload.detail ?? payload.error ?? `Request failed (${response.status}).`;
    if (typeof payload.code === "string")
      throw new ApiError(message, response.status, payload.code);
    throw new ApiError(message, response.status);
  }
  return payload;
};
