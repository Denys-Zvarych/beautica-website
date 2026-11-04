// Guest cancel logic (phase 004): pure, no DOM. Backend contract: GET + POST /api/v1/book/cancel/{token}
// (PublicBookingController.java:125,136). GET -> CancelTokenInfoResponse, POST -> 204.
import { call } from "../scripts/booking/http.ts";

export type CancelState = "confirm" | "closed" | "notfound" | "error" | "cancelled" | "readonly";

export interface CancelInfo {
  masterName: string;
  serviceName: string;
  startsAt: string;
  cancellable: boolean;
  windowClosesAt: string;
  /** Phase 435: CONFIRMED | CANCELLED | DECLINED | COMPLETED | NOT_COMPLETED (absent on an older backend = CONFIRMED). */
  status?: string;
  /** Website-relative «записатись знову» path, or null. */
  rebookPath?: string | null;
  /** Salon bookings only; null otherwise (absent on an older backend). Shown as text. */
  salonName?: string | null;
  address?: string | null;
  /** Entrance hint, shown in brackets after the address (only with an address). Text only. */
  locationNote?: string | null;
}

/** A displayable text fact: a non-blank string, trimmed; anything else (null, absent, non-string) = no row. */
export function factText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** «Address (note)»: the note is shown only with an address; no address = no value (the row stays hidden). */
export function addressWithNote(address: unknown, note: unknown): string | null {
  const a = factText(address);
  const n = factText(note);
  return a ? (n ? `${a} (${n})` : a) : null;
}

/** Only our own link-page paths are offered as «Записатися знову» (never an arbitrary URL from the response). */
export function safeRebookPath(p: unknown): string | null {
  return typeof p === "string" && /^\/book\/(s\/)?(?!cancel$)[a-z0-9][a-z0-9-]*$/.test(p) ? p : null;
}

/** Which read-only copy variant a booking status gets (page data attributes `data-ro-title-*` / `data-ro-text-*`). Unknown values = plain details. */
export type ReadonlyKind = "cancelled" | "completed" | "notCompleted" | "other";
export function readonlyKind(status: string | undefined): ReadonlyKind {
  if (status === "CANCELLED" || status === "DECLINED") return "cancelled";
  if (status === "COMPLETED") return "completed";
  if (status === "NOT_COMPLETED") return "notCompleted";
  return "other";
}

/** Short link /c/{16 alphanumerics} (case-sensitive) or the legacy /book/cancel/{uuid}; the token goes to the API unchanged. */
const SHORT = "[0-9A-Za-z]{16}";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SHORT_RE = new RegExp(`^/c/(${SHORT})/?$`);
const LEGACY_RE = new RegExp(`^/book/cancel/(${UUID})/?$`, "i");
const SHORT_ONLY = new RegExp(`^${SHORT}$`);
const UUID_ONLY = new RegExp(`^${UUID}$`, "i");

/** Server-side token shape check (same rules as tokenFromPath): 16 alphanumerics or a UUID. */
export function isValidCancelToken(token: unknown): token is string {
  return typeof token === "string" && (SHORT_ONLY.test(token) || UUID_ONLY.test(token));
}

export function tokenFromPath(pathname: string): string | null {
  return SHORT_RE.exec(pathname)?.[1] ?? LEGACY_RE.exec(pathname)?.[1] ?? null;
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
  // Phase 435: any status other than CONFIRMED (an unknown value too) is a read-only view, never a cancel offer.
  if (r.data.status && r.data.status !== "CONFIRMED") return { state: "readonly", info: r.data };
  return { state: r.data.cancellable ? "confirm" : "closed", info: r.data };
}

export async function cancelBooking(api: string, token: string): Promise<CancelState> {
  const r = await call(`${api}/api/v1/book/cancel/${token}`, { method: "POST" }, () => true);
  return r.ok ? "cancelled" : stateForStatus(r.status ?? 0);
}

export function formatWhen(iso: string, locale = "uk-UA"): string {
  return new Intl.DateTimeFormat(locale, { timeZone: "Europe/Kyiv", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
