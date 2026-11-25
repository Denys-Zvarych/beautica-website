// W041 /admin/catalog: list categories with their service types, rename, hide / unhide, delete (B504 + B505). Pure (no Worker env): the page passes the
// config, tests pass a fake fetch. Plain HTML form POSTs (CSP has no script): POST -> 303 -> GET with a flash code in the query. Backend message text is never echoed.
import { adminFetch, CATALOG_PREFIX, type UsageCounts } from "./api.ts";
import type { AdminConfig } from "./config.ts";
import { NAME_CAP, KEEP_MAX, cp, field, parsePage } from "./common.ts";
import { parseCatalogFilter, parseQuery } from "./listQuery.ts";

export { KEEP_MAX, parsePage };
export const PAGE_SIZE = 10; // categories per page
export const FLASH_COOKIE = "adm_cat_name"; // HttpOnly one-shot cookie: the typed [name, nameEn] of a failed edit, for ONE re-render
export const KINDS = ["category", "type"] as const;
export type Kind = (typeof KINDS)[number];
export const ACTIONS = ["save", "hide", "show", "delete"] as const;
const WIRE = /^[A-Z][A-Z0-9_]{0,99}$/; // platform_categories.name (chk_platform_categories_name)
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type Status = "APPROVED" | "PENDING" | "REJECTED";
export interface Category { name: string; displayName: string; status: Status; active: boolean; usageCount: number; typeCount: number }
export interface ServiceType { id: string; slug: string; nameUk: string; nameEn: string; active: boolean; usageCount: number }
export interface CategoryRow { category: Category; types?: ServiceType[] | null } // undefined = not loaded (only the `open` category loads its types), null = the load failed

/** `?done=` and `?err=` codes; every one has copy in uk.json `admin.catalog.flash.*`. */
export const DONE_CODES = ["saved", "hidden", "shown", "deleted", "unchanged"] as const;
export const ERR_CODES = ["TYPE_EXISTS", "CATEGORY_NAME_EXISTS", "CATEGORY_NOT_APPROVED", "CATEGORY_ICON_REQUIRED", "CATALOG_IN_USE", "NAME_MISMATCH", "BAD_INPUT", "NOT_FOUND", "CONFLICT", "UNAVAILABLE", "FAILED"] as const;
export type ErrCode = (typeof ERR_CODES)[number];
const TYPED = new Set<string>(["TYPE_EXISTS", "CATEGORY_NAME_EXISTS", "CATEGORY_NOT_APPROVED", "CATEGORY_ICON_REQUIRED", "CATALOG_IN_USE"]);

/** Backend failure -> flash code. Typed `data.code` first (409 only); 400 / 404 / other 409 / 5xx get generic copy. */
export function errToFlash(status: number, code: string): ErrCode {
  if (status === 409 && TYPED.has(code)) return code as ErrCode;
  if (status === 400) return "BAD_INPUT";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 0 || status >= 500) return "UNAVAILABLE";
  return "FAILED";
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const parseCategory = (r: unknown): Category | null => {
  const o = r as Record<string, unknown> | null, name = str(o?.name), status = str(o?.status);
  if (!o || !name || !WIRE.test(name) || !(status === "APPROVED" || status === "PENDING" || status === "REJECTED")) return null;
  return { name, displayName: str(o.displayName) ?? name, status, active: o.active !== false, usageCount: num(o.usageCount), typeCount: num(o.typeCount) };
};
const parseType = (r: unknown): ServiceType | null => {
  const o = r as Record<string, unknown> | null, id = str(o?.id), nameUk = str(o?.nameUk);
  if (!o || !id || !UUID.test(id) || nameUk === null) return null;
  return { id, slug: str(o.slug) ?? "", nameUk, nameEn: str(o.nameEn) ?? "", active: o.active !== false, usageCount: num(o.usageCount) };
};
const COLLATOR = new Intl.Collator("uk"); // one per isolate

export type ListResult = { ok: true; rows: CategoryRow[]; total: number; totalPages: number; page: number } | { ok: false; err: ErrCode };

/**
 * One page of categories (sorted by display name; the backend list is unpaged and small). Only the `open` category (`?open=<wire name>`) carries its types:
 * 2 backend calls per page however long the catalog is, and a light page (a type row is ~2 KB of markup; 10 categories x 12 types was 231 KB).
 * A category with 0 types costs no request; a failed type list is `types: null`.
 */
export async function listCatalog(cfg: AdminConfig, actor: string, page = 1, open: string | null = null): Promise<ListResult> {
  const all = await loadCategories(cfg, actor);
  if (!all.ok) return all;
  const slice = all.cats.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const rows = await Promise.all(slice.map(async (category): Promise<CategoryRow> => (category.name !== open ? { category } : { category, types: await loadTypes(cfg, actor, category) })));
  return { ok: true, rows, total: all.cats.length, totalPages: Math.ceil(all.cats.length / PAGE_SIZE), page };
}

/** W052: the whole category list, sorted by display name (`uk`); the page filters, searches and pages it itself. One backend call. */
export async function loadCategories(cfg: AdminConfig, actor: string): Promise<{ ok: true; cats: Category[] } | { ok: false; err: ErrCode }> {
  const r = await adminFetch(cfg, "GET", `${CATALOG_PREFIX}categories`, actor);
  if (!r.ok) return { ok: false, err: errToFlash(r.status, r.code) };
  return { ok: true, cats: (Array.isArray(r.data) ? r.data : []).map(parseCategory).filter((c): c is Category => c !== null).sort((a, b) => COLLATOR.compare(a.displayName, b.displayName)) };
}
/** The service types of one category: `[]` costs no request when it has none; `null` = the load failed. */
export async function loadTypes(cfg: AdminConfig, actor: string, category: Category): Promise<ServiceType[] | null> {
  if (category.typeCount === 0) return [];
  const t = await adminFetch(cfg, "GET", `${CATALOG_PREFIX}categories/${encodeURIComponent(category.name)}/service-types`, actor);
  return !t.ok || !Array.isArray(t.data) ? null : t.data.map(parseType).filter((x): x is ServiceType => x !== null);
}

/** `[n, ...]` counts of a refused delete -> the query params that carry them to the flash (digits only). */
const countParams = (c: UsageCounts | undefined): Record<string, string> => {
  const q: Record<string, string> = {};
  if (c?.serviceTypes) q.st = String(c.serviceTypes);
  if (c?.definitions) q.df = String(c.definitions);
  if (c?.pendingSuggestions) q.ps = String(c.pendingSuggestions);
  return q;
};
/** The query params of a flash back to counts (digits only, capped), for the page. */
export const countsFromQuery = (q: URLSearchParams): { st: number; df: number; ps: number } => {
  const n = (k: string): number => (/^\d{1,9}$/.test(q.get(k) ?? "") ? Number(q.get(k)) : 0);
  return { st: n("st"), df: n("df"), ps: n("ps") };
};

export interface Decision {
  /** Relative redirect target (POST -> 303 -> GET). */
  location: string;
  /** JSON `[name, nameEn]` the owner typed in a failed edit, for the page's one-shot flash cookie (never the URL). */
  typed?: string;
}

/** Handle one row's form POST. Never throws on backend failure. */
export async function decide(cfg: AdminConfig, actor: string, form: FormData): Promise<Decision> {
  const kind = field(form, "kind"), id = field(form, "id"), action = field(form, "action"), pg = parsePage(field(form, "p"));
  const cat = field(form, "cat"); // a type row's category: keeps its <details> open after the redirect
  const ff = parseCatalogFilter(field(form, "f")), fq = parseQuery(field(form, "q")); // the list filter the action came from (hidden fields), kept across the redirect
  const ctx: Record<string, string> = { ...(ff !== "ALL" ? { f: ff } : {}), ...(fq ? { q: fq } : {}) };
  const back = (q: Record<string, string>): string => `/admin/catalog?${new URLSearchParams({ ...q, ...(pg > 1 ? { p: String(pg) } : {}), ...ctx })}`;
  const isCat = kind === "category";
  if (!(KINDS as readonly string[]).includes(kind) || !(isCat ? WIRE : UUID).test(id) || !(ACTIONS as readonly string[]).includes(action) || (!isCat && !WIRE.test(cat))) return { location: back({ err: "FAILED" }) };
  const open = isCat ? id : cat;
  const row = `${isCat ? "c" : "t"}:${id}`;
  const base = isCat ? `${CATALOG_PREFIX}categories/${id}` : `${CATALOG_PREFIX}service-types/${id}`; // id is a validated wire name / uuid: nothing to encode
  const fail = (err: ErrCode, typed?: string): Decision => ({ location: back({ err, open, card: row }), typed });

  if (action === "delete") {
    // W052 D4: the typed name must equal the AUTHORITATIVE name loaded server-side (never the form's `origName`, which a forged POST controls); case-sensitive; no DELETE without it
    const typedName = field(form, "confirmName").trim();
    if (typedName === "") return { location: back({ err: "NAME_MISMATCH", open, card: row }) };
    const cats = await loadCategories(cfg, actor);
    if (!cats.ok) return { location: back({ err: cats.err, open, card: row }) };
    const owner = cats.cats.find((c) => c.name === open);
    let real: string | undefined;
    if (isCat) real = owner?.displayName;
    else if (owner) {
      const types = await loadTypes(cfg, actor, owner);
      if (types === null) return { location: back({ err: "UNAVAILABLE", open, card: row }) };
      real = types.find((x) => x.id.toLowerCase() === id.toLowerCase())?.nameUk;
    }
    if (real === undefined) return { location: back({ err: "NOT_FOUND", open, card: row }) };
    if (typedName !== real.trim()) return { location: back({ err: "NAME_MISMATCH", open, card: row }) };
    const r = await adminFetch(cfg, "DELETE", base, actor);
    if (r.ok) return { location: back({ done: "deleted", ...(isCat ? {} : { open }) }) };
    const err = errToFlash(r.status, r.code);
    return { location: back({ err, open, ...(err === "CATALOG_IN_USE" ? { ...(isCat ? {} : { type: id }), ...countParams(r.counts) } : {}) }) }; // a type row names itself so the page can show its «Видалити не можна» panel
  }
  if (action === "hide" || action === "show") {
    const r = await adminFetch(cfg, "PATCH", base, actor, { active: action === "show" });
    return { location: r.ok ? back({ done: action === "hide" ? "hidden" : "shown", open }) : back({ err: errToFlash(r.status, r.code), open }) };
  }

  // save: only the changed names go out; nothing changed = no backend call
  const name = field(form, "name").trim(), orig = field(form, "origName");
  const en = isCat ? "" : field(form, "nameEn").trim(), origEn = isCat ? "" : field(form, "origNameEn");
  const keep = (e: ErrCode): Decision => fail(e, JSON.stringify([[...name].slice(0, KEEP_MAX).join(""), [...en].slice(0, KEEP_MAX).join("")]));
  if (name === "" || cp(name) > NAME_CAP || cp(en) > NAME_CAP) return keep("BAD_INPUT"); // no backend call for an empty or absurd payload
  const body: Record<string, string> = {};
  if (name !== orig) body[isCat ? "displayName" : "nameUk"] = name;
  if (!isCat && en !== origEn) body.nameEn = en; // "" clears the English name
  if (Object.keys(body).length === 0) return { location: back({ done: "unchanged", open }) };
  const r = await adminFetch(cfg, "PATCH", base, actor, body);
  return r.ok ? { location: back({ done: "saved", open }) } : keep(errToFlash(r.status, r.code));
}
