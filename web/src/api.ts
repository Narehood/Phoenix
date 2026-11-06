let csrfToken = "";
let sessionVersion = 0;
export const sessionExpiredEvent = "phoenix:session-expired";
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
  sessionVersion++;
}
export const accessLost = (error: unknown) =>
  error instanceof ApiError && [401, 403, 404].includes(error.status);
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const version = sessionVersion;
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
  // A rejected authentication challenge need not invalidate the session.
  // Ignore old-session failures after a later login has replaced its token.
  if (
    response.status === 401 &&
    version === sessionVersion &&
    !path.startsWith("/api/auth/")
  )
    window.dispatchEvent(new Event(sessionExpiredEvent));
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
