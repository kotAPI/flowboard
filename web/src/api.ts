import type { ApiErrorBody } from "./types";

export class ApiError extends Error {
  constructor(public status: number, public body: ApiErrorBody) {
    super(body.message);
  }
  detailFor(path: string) {
    return this.body.details?.find((d) => d.path === path)?.message;
  }
}

const USER_KEY = "flowboard.user";

export function currentUserId(): string {
  try {
    return localStorage.getItem(USER_KEY) ?? "alice";
  } catch {
    return "alice";
  }
}

export function setCurrentUserId(id: string) {
  try {
    localStorage.setItem(USER_KEY, id);
  } catch {}
}

/**
 * Thin fetch wrapper. Identity goes in X-User-Id (the API's mock auth); the server resolves the
 * user and role itself, the client never sends a role.
 */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "x-user-id": currentUserId(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({ error: { code: "BAD_RESPONSE", message: res.statusText } }));
  if (!res.ok) throw new ApiError(res.status, json.error);
  return json as T;
}

export const get = <T>(path: string) => api<{ data: T }>("GET", path).then((r) => r.data);
export const post = <T>(path: string, body: unknown = {}) => api<{ data: T }>("POST", path, body).then((r) => r?.data);
export const patch = <T>(path: string, body: unknown) => api<{ data: T }>("PATCH", path, body).then((r) => r.data);
export const del = (path: string) => api<unknown>("DELETE", path);

export const containerPath = (type: string, id: string) => (type === "workspace" ? "/v1/workspace" : `/v1/${type}s/${id}`);
