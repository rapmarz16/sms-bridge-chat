export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

function csrfToken(): string | undefined {
  const cookie = document.cookie.split("; ").find((item) => item.startsWith("sbc_csrf="));
  return cookie ? decodeURIComponent(cookie.split("=").slice(1).join("=")) : undefined;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const method = (init.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrf = csrfToken();
    if (csrf) headers.set("x-csrf-token", csrf);
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    let payload: { message?: string; error?: string } = {};
    try { payload = await response.json() as typeof payload; } catch { /* no structured body */ }
    throw new ApiError(payload.message ?? `Request failed (${response.status})`, response.status, payload.error);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}
