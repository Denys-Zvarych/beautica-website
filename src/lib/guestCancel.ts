// Guest cancel logic (phase 004): pure, no DOM. Backend contract: GET + POST /api/v1/book/cancel/{token}
// (PublicBookingController.java:125,136). GET -> CancelTokenInfoResponse, POST -> 204.
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

export async function fetchInfo(api: string, token: string, signal: AbortSignal): Promise<{ state: CancelState; info?: CancelInfo }> {
  try {
    const res = await fetch(`${api}/api/v1/book/cancel/${token}`, { headers: { Accept: "application/json" }, signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
    if (!res.ok) return { state: stateForStatus(res.status) };
    const info = (await res.json()) as CancelInfo;
    return { state: info.cancellable ? "confirm" : "closed", info };
  } catch {
    return { state: "error" };
  }
}

export async function cancelBooking(api: string, token: string, signal: AbortSignal): Promise<CancelState> {
  try {
    const res = await fetch(`${api}/api/v1/book/cancel/${token}`, { method: "POST", signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
    return res.status === 204 || res.ok ? "cancelled" : stateForStatus(res.status);
  } catch {
    return "error";
  }
}

export function formatWhen(iso: string, locale = "uk-UA"): string {
  return new Intl.DateTimeFormat(locale, { timeZone: "Europe/Kyiv", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
