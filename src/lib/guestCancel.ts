// Guest cancel logic (phase 004): pure, no DOM. Backend contract: GET + POST /api/v1/book/cancel/{token}
// (PublicBookingController.java:125,136). GET -> CancelTokenInfoResponse, POST -> 204.
import { call, post } from "../scripts/booking/http.ts";

export type CancelState = "confirm" | "closed" | "notfound" | "error" | "cancelled" | "readonly";

/** One service of the visit (phase 026). `status` as CancelInfo.status. */
export interface CancelItem {
  bookingId: string;
  serviceName: string;
  startsAt: string;
  durationMinutes: number;
  status: string;
  cancellable: boolean;
}

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
  /** Phase 026: every service of the visit, ordered by time. Absent on an older backend = the single-service view. */
  items?: CancelItem[];
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

const isItem = (v: unknown): v is CancelItem => {
  const i = v as Partial<CancelItem> | null;
  return !!i && typeof i.bookingId === "string" && typeof i.serviceName === "string" && typeof i.startsAt === "string" && typeof i.cancellable === "boolean";
};

/** The usable items of an answer, or [] (absent / malformed = the single-service view). A one-item list is still the single view (see isMulti). */
export function itemsOf(info: CancelInfo | null | undefined): CancelItem[] {
  return Array.isArray(info?.items) && info.items.every(isItem) ? info.items : [];
}

/** More than one service: the guest ticks what to cancel. One item (or none) keeps today's single button. */
export const isMulti = (info: CancelInfo | null | undefined): boolean => itemsOf(info).length > 1;

/** Which page state an answer maps to. Multi: something still cancellable = confirm; nothing cancellable and something only too late = closed; otherwise read-only. */
export function stateForInfo(info: CancelInfo): CancelState {
  if (isMulti(info)) {
    const items = itemsOf(info);
    if (items.some((i) => i.cancellable)) return "confirm";
    return items.some((i) => i.status === "CONFIRMED") ? "closed" : "readonly";
  }
  // Phase 435: any status other than CONFIRMED (an unknown value too) is a read-only view, never a cancel offer.
  if (info.status && info.status !== "CONFIRMED") return "readonly";
  return info.cancellable ? "confirm" : "closed";
}

const GONE = new Set(["CANCELLED", "DECLINED"]);
/** «Скасовано N з M»: services of the visit that are cancelled / declined, and the total. */
export function cancelledCount(items: CancelItem[]): { done: number; total: number } {
  return { done: items.filter((i) => GONE.has(i.status)).length, total: items.length };
}

/** Why a row cannot be ticked: copy key suffix for cancelled / completed / too late (anything else not cancellable = too late). */
export function itemReason(i: CancelItem): "cancelled" | "completed" | "late" | null {
  if (i.cancellable) return null;
  if (GONE.has(i.status)) return "cancelled";
  if (i.status === "COMPLETED" || i.status === "NOT_COMPLETED") return "completed";
  return "late";
}

/** Read-only kind of a whole visit with nothing cancellable: all gone = cancelled, all completed = completed, otherwise plain details. */
export function readonlyKindOf(info: CancelInfo): ReadonlyKind {
  const items = itemsOf(info);
  if (items.length < 2) return readonlyKind(info.status);
  if (items.every((i) => GONE.has(i.status))) return "cancelled";
  if (items.every((i) => i.status === "COMPLETED")) return "completed";
  return "other";
}

/** «Скасувати 1 послугу / 2 послуги / 5 послуг»: `forms` = [one, few, many] with {n}. */
export function countLabel(n: number, forms: [string, string, string]): string {
  const m = n % 100 > 10 && n % 100 < 15 ? 0 : n % 10;
  return forms[m === 1 ? 0 : m > 1 && m < 5 ? 1 : 2].replace("{n}", String(n));
}

// Both calls go through the shared `call` (credential-less, no-store, no-referrer, 15 s timeout): the cancel page then ships no fetch code of its own.
export async function fetchInfo(api: string, token: string): Promise<{ state: CancelState; info?: CancelInfo }> {
  const r = await call(`${api}/api/v1/book/cancel/${token}`, { headers: { Accept: "application/json" } }, (j) => j as CancelInfo | null);
  if (!r.ok) return { state: stateForStatus(r.status ?? 0) };
  return { state: stateForInfo(r.data), info: r.data };
}

/** `bookingIds` omitted = today's body-less POST (single-service view / older backend). The answer is the same shape as the GET (an older backend answers 204: `info` absent = cancelled). */
export async function cancelBooking(api: string, token: string, bookingIds?: string[]): Promise<{ state: CancelState; info?: CancelInfo }> {
  const init: RequestInit = bookingIds ? post({ bookingIds }) : { method: "POST" };
  const r = await call(`${api}/api/v1/book/cancel/${token}`, init, (j) => (j && typeof j === "object" ? (j as CancelInfo) : ({} as CancelInfo)));
  if (!r.ok) return { state: stateForStatus(r.status ?? 0) };
  return Array.isArray(r.data.items) ? { state: "cancelled", info: r.data } : { state: "cancelled" };
}

const kyiv = (o: Intl.DateTimeFormatOptions) => (iso: string, locale = "uk-UA"): string => new Intl.DateTimeFormat(locale, { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", ...o }).format(new Date(iso));
export const formatWhen = kyiv({ day: "numeric", month: "long" });
export const formatTime = kyiv({});
