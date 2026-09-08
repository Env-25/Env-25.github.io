import { getIdToken } from "./auth";
import { AUTH_CONFIG } from "./auth-config";

export type AdminWorkspace =
  | "lockers"
  | "merch"
  | "notifications"
  | "members"
  | "events"
  | "resources"
  | "admin";

async function request<T>(path = "", init: RequestInit = {}): Promise<T> {
  const base = AUTH_CONFIG.adminApiUrl?.replace(/\/$/, "");
  if (!base) throw new Error("The admin service is not configured yet.");
  const token = await getIdToken({ forceRefresh: true });
  if (!token) throw new Error("Your session has expired. Sign in again.");
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "The admin request failed.");
  return body as T;
}

export function getAdmin<T>(params: Record<string, string>): Promise<T> {
  const search = new URLSearchParams(params);
  return request<T>(`?${search.toString()}`);
}

export function postAdmin<T>(body: Record<string, unknown>): Promise<T> {
  return request<T>("", { method: "POST", body: JSON.stringify(body) });
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}
