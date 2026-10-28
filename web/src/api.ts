let csrfToken = "";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export function csrf(value: string) {
  csrfToken = value;
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(method === "GET" ? {} : { "X-CSRF-Token": csrfToken }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data: unknown = await response.json().catch((error: unknown) => {
    if (response.ok) throw error;
    return null;
  });
  if (!response.ok)
    throw new ApiError(
      typeof data === "object" && data && "error" in data
        ? String(data.error)
        : `Request failed (${response.status})`,
      response.status,
    );
  return data as T;
}
