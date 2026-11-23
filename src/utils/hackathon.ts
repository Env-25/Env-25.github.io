/**
 * Browser helpers for the CHBE Hackathon API.
 * All write calls use the signed-in user's Cognito ID token.
 */
import { getIdToken } from "./auth";
import { AUTH_CONFIG } from "./auth-config";

export type HackathonTeammate = {
  name: string;
  email: string;
  studentNumber: string;
  participantId: number | null;
};

export type HackathonParticipant = {
  participantId: number;
  role: "first-year" | "upper-year";
  name: string;
  email: string;
  studentNumber: string;
  academicYear: string;
  academicYearOther: string;
  isTeamLead: boolean;
  teammate: HackathonTeammate | null;
  createdAt: string;
};

export function isHackathonConfigured(): boolean {
  return Boolean(AUTH_CONFIG.hackathonApiUrl);
}

function apiBase(): string {
  const base = AUTH_CONFIG.hackathonApiUrl?.replace(/\/$/, "");
  if (!base) throw new Error("The hackathon service is not configured yet.");
  return base;
}

async function authedFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getIdToken({ forceRefresh: true });
  if (!token) throw new Error("Your session has expired. Sign in again.");
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || "The request failed.") as Error & {
      code?: string;
      status?: number;
    };
    err.code = body.code;
    err.status = res.status;
    throw err;
  }
  return body as T;
}

/** Returns the signed-in user's participant record, or null if not registered. */
export function getMyParticipant(): Promise<{ participant: HackathonParticipant | null }> {
  return authedFetch("/?me=1", { method: "GET" });
}

/** Non-committing partner eligibility check for the first-year flow. */
export function validatePartner(partnerEmail: string): Promise<{
  ok: boolean;
  partner: { name: string; email: string };
}> {
  return authedFetch("/", {
    method: "POST",
    body: JSON.stringify({ action: "validate-partner", partnerEmail }),
  });
}

export function registerFirstYear(input: {
  studentNumber: string;
  partnerStudentNumber: string;
  partnerEmail: string;
}): Promise<{
  ok: boolean;
  participantId: number;
  partnerParticipantId: number;
  role: string;
}> {
  return authedFetch("/", {
    method: "POST",
    body: JSON.stringify({ action: "register-first-year", ...input }),
  });
}

export function registerUpperYear(input: {
  studentNumber: string;
  academicYear: string;
  academicYearOther?: string;
}): Promise<{ ok: boolean; participantId: number; role: string }> {
  return authedFetch("/", {
    method: "POST",
    body: JSON.stringify({ action: "register-upper-year", ...input }),
  });
}
