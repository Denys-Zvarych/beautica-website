// W049 (WEB-71): the category-icon upload of /admin. The browser posts multipart to /admin/icon; the Worker checks the file BEFORE any backend call (size, `.svg`, SVG start),
// then forwards JSON `{svg}` (B539 `PUT .../categories/{name}/icon`) so `adminFetch` stays JSON-only. The backend stays the authority (it rejects, never strips).
// Pure (no Worker env): the route passes the config, tests pass a fake fetch. The 303 target is REBUILT from whitelisted params, never echoed (no open redirect).
import { adminFetch, CATALOG_PREFIX } from "./api.ts";
import type { AdminConfig } from "./config.ts";
import { WIRE, field, parsePage } from "./common.ts";
import { errToFlash } from "./catalog.ts";
import { parseCatalogFilter, parseKindFilter, parseQuery, withQuery } from "./listQuery.ts";

export const ICON_MAX = 16 * 1024; // bytes, the file (SVC-59)
export const BODY_MAX = 32 * 1024; // bytes, the whole multipart request (refused before parsing)
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const REQ_KEY = /^(?:CATEGORY|SERVICE_TYPE):[0-9A-Za-z-]{1,40}$/;
const PAGES = ["/admin/catalog", "/admin/requests"] as const;
const GENERIC = new Set<string>(["BAD_INPUT", "NOT_FOUND", "CONFLICT", "UNAVAILABLE", "FAILED"]);
const DEFAULT_PAGE = "/admin/catalog";

/** B539 `data.reason` -> flash code. An unknown reason reads as a broken file. */
const REASONS: Record<string, string> = {
  TOO_LARGE: "ICON_TOO_LARGE",
  NOT_SVG: "ICON_BROKEN",
  BAD_VIEWBOX: "ICON_BAD_VIEWBOX",
  FORBIDDEN_ELEMENT: "ICON_FORBIDDEN",
  FORBIDDEN_ATTRIBUTE: "ICON_FORBIDDEN",
  EXTERNAL_REF: "ICON_FORBIDDEN",
  FORBIDDEN_COLOUR: "ICON_COLOUR",
};
export const reasonToFlash = (reason: string | undefined): string => (reason && REASONS[reason]) || "ICON_BROKEN";

/** The page + query a form asked to come back to, rebuilt from parsed params of ONE of the two admin pages. Anything else gives the catalog. */
export function safeReturn(raw: string): { path: string; params: Record<string, string> } {
  const dflt = { path: DEFAULT_PAGE, params: {} };
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return dflt;
  let u: URL;
  try { u = new URL(raw, "https://admin.invalid"); } catch { return dflt; }
  if (u.origin !== "https://admin.invalid" || !(PAGES as readonly string[]).includes(u.pathname)) return dflt;
  const g = (k: string) => u.searchParams.get(k) ?? "";
  const params: Record<string, string> = {};
  const p = parsePage(g("p"));
  if (p > 1) params.p = String(p);
  const q = parseQuery(g("q"));
  if (q) params.q = q;
  if (u.pathname === "/admin/catalog") {
    const f = parseCatalogFilter(g("f"));
    if (f !== "ALL") params.f = f;
    if (WIRE.test(g("open"))) params.open = g("open");
    if (["rename", "disable", "enable", "delete", "icon"].includes(g("dlg"))) params.dlg = g("dlg");
    if (WIRE.test(g("cat"))) params.cat = g("cat");
    if (UUID.test(g("type"))) params.type = g("type");
  } else {
    const k = parseKindFilter(g("kind"));
    if (k !== "ALL") params.kind = k;
    if (REQ_KEY.test(g("open"))) params.open = g("open");
    if (["approve", "reject", "icon"].includes(g("dlg"))) params.dlg = g("dlg");
    if (REQ_KEY.test(g("id"))) params.id = g("id");
    if (WIRE.test(g("cat"))) params.cat = g("cat");
  }
  return { path: u.pathname, params };
}

/** Read the request body up to BODY_MAX (+1 byte to detect an overrun), without trusting Content-Length. null = too large. */
async function readCapped(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const body = request.body;
  if (!body) return new Uint8Array(new ArrayBuffer(0));
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > BODY_MAX) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(n));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** `<svg` or `<?xml` after an optional BOM and whitespace. */
export const looksLikeSvg = (text: string): boolean => /^(?:﻿)?\s*(?:<svg[\s>/]|<\?xml[\s?])/.test(text);

/** Handle one icon-upload POST. Never throws on backend failure. Returns the relative 303 target. */
export async function uploadIcon(cfg: AdminConfig, actor: string, request: Request): Promise<{ location: string }> {
  const fail = (err: string, ret = safeReturn("")): { location: string } => ({ location: withQuery(ret.path, { ...ret.params, err }) });
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BODY_MAX) return fail("ICON_TOO_LARGE");
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return fail("FAILED");
  const bytes = await readCapped(request);
  if (bytes === null) return fail("ICON_TOO_LARGE");
  let form: FormData;
  try {
    form = await new Response(new Blob([bytes]), { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return fail("FAILED");
  }
  const ret = safeReturn(field(form, "return"));
  const category = field(form, "category");
  if (!WIRE.test(category)) return fail("FAILED", ret);
  const file = form.get("icon");
  if (typeof file === "string" || file === null || file.size === 0) return fail("ICON_NO_FILE", ret);
  if (!/\.svg$/i.test(file.name)) return fail("ICON_NOT_SVG", ret);
  if (file.size > ICON_MAX) return fail("ICON_TOO_LARGE", ret);
  const svg = (await file.text()).replace(/^﻿/, "");
  if (!looksLikeSvg(svg)) return fail("ICON_NOT_SVG", ret);

  const r = await adminFetch(cfg, "PUT", `${CATALOG_PREFIX}categories/${category}/icon`, actor, { svg }); // category is a validated wire name: nothing to encode
  if (!r.ok) {
    if (r.status === 400 && r.code === "ICON_INVALID") return fail(reasonToFlash(r.reason), ret);
    const err = errToFlash(r.status, r.code);
    return fail(GENERIC.has(err) ? err : "FAILED", ret); // only codes both pages know
  }
  const replaced = field(form, "replace") === "1";
  const params = { ...ret.params };
  // The icon dialog closes on success; an enable / approve panel stays open, now with the icon attached.
  const keepPanel = params.dlg === "enable" || params.dlg === "approve";
  if (!keepPanel) { if (params.dlg === "icon") delete params.id; delete params.dlg; delete params.cat; }
  const done = replaced ? "icon_replaced" : params.dlg === "approve" ? "icon_added_approve" : "icon_added";
  return { location: withQuery(ret.path, { ...params, done }) };
}
