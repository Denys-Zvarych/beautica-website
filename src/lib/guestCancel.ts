// Guest cancel logic (phase 004): pure, no DOM. Backend contract: GET + POST /api/v1/book/cancel/{token}
// (PublicBookingController.java:125,136). GET -> CancelTokenInfoResponse, POST -> 204.
import { call } from "../scripts/booking/http.ts";

export type CancelState = "confirm" | "closed" | "notfound" | "error" | "cancelled";

export interface CancelInfo {
  masterName: string;
  serviceName: string;
  startsAt: string;
  cancellable: boolean;
  windowClosesAt: string;
}

const TOKEN_RE = /^\/book\/cancel\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export function tokenFromPath(pathname: string): string | null {
  return TOKEN_RE.exec(pathname)?.[1] ?? null;
}

/** 404 and 400 (malformed id) mean "used or invalid"; anything unexpected is a retryable error. */
export function stateForStatus(status: number): CancelState {
  if (status === 404 || status === 400) return "notfound";
  if (status === 422) return "closed";
  return "error";
}

// Both calls go through the shared `call` (credential-less, no-store, no-referrer, 15 s timeout): the cancel page then ships no fetch code of its own.
export async function fetchInfo(api: string, token: string): Promise<{ state: CancelState; info?: CancelInfo }> {
  const r = await call(`${api}/api/v1/book/cancel/${token}`, { headers: { Accept: "application/json" } }, (j) => j as CancelInfo | null);
  if (!r.ok) return { state: stateForStatus(r.status ?? 0) };
  return { state: r.data.cancellable ? "confirm" : "closed", info: r.data };
}

export async function cancelBooking(api: string, token: string): Promise<CancelState> {
  const r = await call(`${api}/api/v1/book/cancel/${token}`, { method: "POST" }, () => true);
  return r.ok ? "cancelled" : stateForStatus(r.status ?? 0);
}

export function formatWhen(iso: string, locale = "uk-UA"): string {
  return new Intl.DateTimeFormat(locale, { timeZone: "Europe/Kyiv", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
