// W040 /admin/requests: list + decide pending catalog requests. Pure (no Worker env): the page passes the config, tests pass a fake fetch.
// Plain HTML form POSTs (CSP has no script): POST -> 303 -> GET. The flash is a query code from FLASH only; backend message text is never echoed.
import { adminFetch, CATALOG_PREFIX } from "./api.ts";
import type { AdminConfig } from "./config.ts";
import { KEEP_MAX, NAME_CAP, WIRE, cp, field, parsePage } from "./common.ts";
import { parseIcon } from "./catalog.ts";
import { imgOriginsFor } from "../mediaOrigin.ts";
import { parseKindFilter, parseQuery } from "./listQuery.ts";

export { KEEP_MAX, NAME_CAP, parsePage }; // moved to ./common.ts (shared with the catalog page); re-exported so existing importers keep working

export const KINDS = ["CATEGORY", "SERVICE_TYPE"] as const;
export type Kind = (typeof KINDS)[number];
export const REASON_MAX = 300; // code points (backend DecisionReason)
export const FLASH_COOKIE = "adm_req_name"; // HttpOnly flash cookie holding the typed name for ONE re-render (set by the POST, cleared by the next GET)
export const PAGE_SIZE = 25; // requests per page (backend `page` is 0-based, the URL's `?p=` is 1-based)
const ID = /^(?:\d{1,19}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export interface CatalogRequest {
  kind: Kind;
  id: string;
  name: string;
  displayName: string | null;
  categoryName: string | null;
  initialServiceName: string | null;
  description: string | null;
  requesterLabel: string;
  createdAt: string;
  /** CATEGORY requests only (W049): string = has an icon, null = none, undefined = not exposed (pre-B539) or a type suggestion. */
  iconUrl?: string | null;
}

/** Success codes (`?done=`) and error codes (`?err=`); every one has copy in uk.json `admin.requests.flash.*`. */
export const DONE_CODES = ["saved", "approved", "rejected", "unchanged"] as const;
export const ERR_CODES = ["REQUEST_NOT_PENDING", "DUPLICATE_PENDING", "TYPE_EXISTS", "CATEGORY_ICON_REQUIRED", "BAD_INPUT", "REASON_TOO_LONG", "NOT_FOUND", "CONFLICT", "UNAVAILABLE", "FAILED"] as const;
export type FlashCode = (typeof DONE_CODES)[number] | (typeof ERR_CODES)[number];
const TYPED = new Set<string>(["REQUEST_NOT_PENDING", "DUPLICATE_PENDING", "TYPE_EXISTS", "CATEGORY_ICON_REQUIRED"]);

/** Backend failure -> flash code. Typed `data.code` first; 400 / 404 / other 409 / 5xx get generic copy. */
export function errToFlash(status: number, code: string): (typeof ERR_CODES)[number] {
  if (status === 409 && TYPED.has(code)) return code as (typeof ERR_CODES)[number];
  if (status === 400) return "BAD_INPUT";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 0 || status >= 500) return "UNAVAILABLE";
  return "FAILED";
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const parseItem = (allow: readonly string[]) => (r: unknown): CatalogRequest | null => {
  const o = r as Record<string, unknown> | null;
  const kind = str(o?.kind), id = str(o?.id), name = str(o?.name);
  if (!o || !(KINDS as readonly string[]).includes(kind ?? "") || !id || !ID.test(id) || name === null) return null;
  return { kind: kind as Kind, id, name, displayName: str(o.displayName), categoryName: str(o.categoryName), initialServiceName: str(o.initialServiceName), description: str(o.description), requesterLabel: str(o.requesterLabel) ?? "—", createdAt: str(o.createdAt) ?? "", ...(kind === "CATEGORY" ? parseIcon(o, allow) : {}) };
};

export type ListResult = { ok: true; items: CatalogRequest[]; total: number; totalPages: number; page: number } | { ok: false; err: (typeof ERR_CODES)[number] };

/** Pending requests, oldest first (the backend orders them; sorted again here so the page never depends on it). */
export async function listPending(cfg: AdminConfig, actor: string, page = 1): Promise<ListResult> {
  const r = await adminFetch(cfg, "GET", `${CATALOG_PREFIX}requests?status=PENDING&page=${page - 1}&size=${PAGE_SIZE}`, actor);
  if (!r.ok) return { ok: false, err: errToFlash(r.status, r.code) };
  const pg = r.data as { data?: unknown; totalElements?: unknown; totalPages?: unknown } | unknown[] | null;
  const rows = Array.isArray(pg) ? pg : Array.isArray((pg as { data?: unknown } | null)?.data) ? (pg as { data: unknown[] }).data : [];
  const items = rows.map(parseItem(imgOriginsFor(cfg))).filter((x): x is CatalogRequest => x !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const total = typeof (pg as { totalElements?: unknown } | null)?.totalElements === "number" ? (pg as { totalElements: number }).totalElements : items.length;
  const tp = (pg as { totalPages?: unknown } | null)?.totalPages;
  return { ok: true, items, total, totalPages: typeof tp === "number" && tp >= 0 ? tp : items.length ? 1 : 0, page };
}

/** Pending requests for the W052 list: the Worker pages `listPending` until done and filters / searches itself (the backend has no search). Cap: 8 pages of 25. */
export const REQUEST_CAP = 200;
export type AllResult = { ok: true; items: CatalogRequest[]; total: number; capped: boolean } | { ok: false; err: (typeof ERR_CODES)[number] };
export async function listAllPending(cfg: AdminConfig, actor: string): Promise<AllResult> {
  const first = await listPending(cfg, actor, 1);
  if (!first.ok) return first;
  const items = [...first.items];
  const last = Math.min(first.totalPages, Math.ceil(REQUEST_CAP / PAGE_SIZE)); // pages 2..8 in ONE round trip (same call count as the serial loop)
  const rest = await Promise.all(Array.from({ length: Math.max(0, last - 1) }, (_, i) => listPending(cfg, actor, i + 2)));
  for (const next of rest) {
    if (!next.ok) return next; // the first failing page, in page order
    items.push(...next.items);
  }
  const capped = first.total > REQUEST_CAP || items.length > REQUEST_CAP;
  return { ok: true, items: items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, REQUEST_CAP), total: first.total, capped };
}

/** Redirect target; the current page `p` (> 1) is kept so a decision never throws the owner back to page 1, and the list filter (`kind`, `q`) rides along when set. */
const backTo = (q: Record<string, string>, p = 1, ctx: Record<string, string> = {}): string => `/admin/requests?${new URLSearchParams({ ...q, ...(p > 1 ? { p: String(p) } : {}), ...ctx })}`;

export interface Decision {
  /** Relative redirect target (POST -> 303 -> GET). */
  location: string;
  /** The typed name to give back to the card after a failed edit: the page keeps it in a short-lived flash cookie, never in the URL. */
  typed?: string;
}

/** Handle one card's form POST. Never throws on backend failure. */
export async function decide(cfg: AdminConfig, actor: string, form: FormData): Promise<Decision> {
  const kind = field(form, "kind"), id = field(form, "id"), action = field(form, "action"), pg = parsePage(field(form, "p"));
  const fk = parseKindFilter(field(form, "fk")), fq = parseQuery(field(form, "fq")); // the list filter the decision came from (hidden fields), kept across the redirect
  const ctx: Record<string, string> = { ...(fk !== "ALL" ? { kind: fk } : {}), ...(fq ? { q: fq } : {}) };
  const back = (q: Record<string, string>): string => backTo(q, pg, ctx);
  if (!(KINDS as readonly string[]).includes(kind) || !ID.test(id) || !["save", "approve", "reject"].includes(action)) return { location: back({ err: "FAILED" }) };
  const card = `${kind}:${id}`;
  const base = `${CATALOG_PREFIX}requests/${kind}/${encodeURIComponent(id)}`;
  const keep = (err: string, typed: string): Decision => ({ location: back({ err, card }), typed: [...typed].slice(0, KEEP_MAX).join("") }); // the input keeps what was typed

  if (action === "reject") {
    const reason = field(form, "reason").trim();
    if (cp(reason) > REASON_MAX) return { location: back({ err: "REASON_TOO_LONG" }) };
    const r = await adminFetch(cfg, "POST", `${base}/reject`, actor, reason ? { reason } : undefined);
    return { location: r.ok ? back({ done: "rejected" }) : back({ err: errToFlash(r.status, r.code) }) };
  }

  const name = field(form, "name").trim(), orig = field(form, "origName");
  const initial = kind === "CATEGORY" ? field(form, "initialServiceName").trim() : null;
  if (cp(name) > NAME_CAP || (initial !== null && cp(initial) > NAME_CAP)) return keep("BAD_INPUT", name); // no backend call for an absurd payload
  const initialChanged = initial !== null && initial !== field(form, "origInitialServiceName");
  if (name !== orig || initialChanged) {
    const body: Record<string, string> = { name };
    if (initialChanged && initial !== null) body.initialServiceName = initial;
    const r = await adminFetch(cfg, "PATCH", base, actor, body); // first error stops the chain (no approve after a failed edit)
    if (!r.ok) return keep(errToFlash(r.status, r.code), name);
  } else if (action === "save") {
    return { location: back({ done: "unchanged" }) };
  }
  if (action === "save") return { location: back({ done: "saved" }) };
  const r = await adminFetch(cfg, "POST", `${base}/approve`, actor);
  if (r.ok) return { location: back({ done: "approved" }) };
  const err = errToFlash(r.status, r.code);
  // B541 refused the approve for lack of an icon: back to the approve panel, which carries the inline upload (W049)
  return { location: back({ err, ...(err === "CATEGORY_ICON_REQUIRED" && kind === "CATEGORY" ? { dlg: "approve", id: card } : {}) }) };
}

/** The wire name an icon upload for a CATEGORY request is keyed by (`name` is the immutable wire name; the display name is separate). null for a type or an odd name. */
export const requestIconTarget = (r: CatalogRequest): string | null => (r.kind === "CATEGORY" && WIRE.test(r.name) ? r.name : null);

const DATE = new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }); // one per isolate: building it per card costs ~65 µs

/** Kyiv-time date for a card. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : DATE.format(d);
}
