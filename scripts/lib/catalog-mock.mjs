// TEST-ONLY stand-in for the backend's internal catalog endpoints (B502/B503, B504/B505), used by scripts/render-admin.mjs so /admin/requests and /admin/catalog render and their
// forms work with sample data. It is NOT reachable from src/: the harness just points the Worker's API_ORIGIN at it. Requires the scoped key + actor
// headers like the real guard (401 / 400). Magic names: "dup" -> 409 DUPLICATE_PENDING, a name with a non-letter symbol -> 400, "exists" -> 409 TYPE_EXISTS, "noicon" approve ->
// 409 CATEGORY_ICON_REQUIRED. State (rows, calls) is created per startCatalogMock() call and the server listens on port 0: runs never share anything. Decided requests leave the pending list; a second decision is 409 REQUEST_NOT_PENDING.
// W041 live catalog (B504 list / rename / hide, B505 delete), same envelope and codes as the backend: PATCH 200 {data:null}; DELETE 204; 409 data.code in
// TYPE_EXISTS | CATEGORY_NAME_EXISTS | CATEGORY_NOT_APPROVED | CATALOG_IN_USE (counts flattened next to the code); a name with a non-letter symbol -> 400; an empty body -> 400;
// un-hiding the category «Без іконки» -> 409 CATEGORY_ICON_REQUIRED (B541). A category is deletable only when it has 0 types and 0 usage; a type only when usage is 0.
// `categories` (env CATALOG_MOCK_CATEGORIES) > 6 pads the seed with generated categories of 12 types each (perf runs: a large catalog).
import { createServer } from "node:http";

const KEY = "test-catalog-key-0000000000000000000";
const seed = () => [
  { kind: "CATEGORY", id: "41", name: "Brow-bar", displayName: "Brow bar", categoryName: null, initialServiceName: "Ламінування брів", description: null, requesterLabel: "Салон «Лотос»", createdAt: "2026-11-10T09:15:00Z", status: "PENDING" },
  { kind: "SERVICE_TYPE", id: "5b0f3c1e-2d4a-4c1b-9a77-0a1b2c3d4e5f", name: "Корекція брів воском", displayName: null, categoryName: "brows", initialServiceName: null, description: "Часто просять клієнти.\nПотрібен окремий тип.", requesterLabel: "Олена Коваленко", createdAt: "2026-11-12T14:40:00Z", status: "PENDING" },
  { kind: "SERVICE_TYPE", id: "9c1d2e3f-4a5b-4c6d-8e7f-001122334455", name: "Нігті", displayName: null, categoryName: "nails", initialServiceName: null, description: null, requesterLabel: "—", createdAt: "2026-11-11T08:00:00Z", status: "PENDING" },
];

const tid = (c, i) => `${String(c).padStart(4, "0")}0000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const seedCatalog = (extra) => {
  const cats = [
    { name: "BROWS", displayName: "Брови", status: "APPROVED", active: true, usage: 12 },
    { name: "NAILS", displayName: "Нігті", status: "APPROVED", active: true, usage: 40 },
    { name: "MASAZH_NIH", displayName: "Масаж ніг (дубль)", status: "APPROVED", active: false, usage: 0 },
    { name: "BEZ_ICONKY", displayName: "Без іконки", status: "APPROVED", active: false, usage: 0 },
    { name: "NEW_CAT", displayName: "Нова категорія", status: "PENDING", active: true, usage: 0 },
    { name: "STRAY", displayName: "Зайва", status: "APPROVED", active: true, usage: 0 },
  ];
  const types = new Map(cats.map((c) => [c.name, []]));
  const add = (cat, n, nameUk, nameEn, active, usage) => types.get(cat).push({ id: tid(cats.findIndex((c) => c.name === cat) + 1, n), slug: `t-${n}`, nameUk, nameEn, active, usage });
  add("BROWS", 1, "Корекція брів", "Brow shaping", true, 9); add("BROWS", 2, "Ламінування брів", "", true, 3); add("BROWS", 3, "Архівний тип", "", false, 0);
  add("NAILS", 1, "Манікюр", "Manicure", true, 30); add("NAILS", 2, "Педикюр", "Pedicure", true, 10); add("NAILS", 3, "Невикористаний тип", "", true, 0);
  add("MASAZH_NIH", 1, "Масаж стоп", "", false, 0);
  for (let i = 0; i < extra; i++) {
    const name = `GEN_${String(i).padStart(4, "0")}`;
    cats.push({ name, displayName: `Категорія ${String(i).padStart(4, "0")}`, status: "APPROVED", active: i % 5 !== 0, usage: i % 4 === 0 ? 0 : 7 });
    types.set(name, []);
    for (let k = 0; k < 12; k++) add(name, k, `Тип ${i}-${k}`, k % 2 ? `Type ${i}-${k}` : "", k % 7 !== 0, k % 3 === 0 ? 0 : 2);
  }
  return { cats, types };
};

/** `rows` (env CATALOG_MOCK_ROWS) > 3 pads the sample data with generated requests (perf runs: 100 cards). */
export async function startCatalogMock(total = Number(process.env.CATALOG_MOCK_ROWS) || 0, categories = Number(process.env.CATALOG_MOCK_CATEGORIES) || 0) {
  const rows = seed();
  // CATALOG_MOCK_AGES="0,2,3,6,7": REPLACES the seed by one pending request per entry, each N whole Kyiv calendar days old (created at 12:00 UTC = 14:00/15:00 Kyiv, so a DST change
  // or a run near midnight never moves it to another day). Names are «Вік N» (id 500+i / a fixed uuid), so band tests do not depend on today's date.
  const ages = (process.env.CATALOG_MOCK_AGES ?? "").split(",").filter((x) => x.trim() !== "").map(Number);
  if (ages.length) {
    const kyivToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date()).split("-").map(Number);
    rows.length = 0;
    ages.forEach((n, i) => rows.push({ kind: i % 2 ? "SERVICE_TYPE" : "CATEGORY", id: i % 2 ? `00000000-0000-4000-8000-${String(900 + i).padStart(12, "0")}` : String(500 + i), name: `Вік ${n}`, displayName: i % 2 ? null : `Вік ${n}`, categoryName: i % 2 ? "brows" : null, initialServiceName: i % 2 ? null : "Перша", description: null, requesterLabel: `Автор ${i}`, createdAt: new Date(Date.UTC(kyivToday[0], kyivToday[1] - 1, kyivToday[2] - n, 12)).toISOString(), status: "PENDING" }));
  }
  const catalog = seedCatalog(Math.max(0, categories - 6));
  // CATALOG_MOCK_EXTRA_CATS='[{"name":"X","displayName":"Ікс","status":"APPROVED","active":true,"usage":21}]' appends exact categories (no types): plural-form and filter-count tests.
  for (const c of JSON.parse(process.env.CATALOG_MOCK_EXTRA_CATS || "[]")) { catalog.cats.push(c); catalog.types.set(c.name, []); }
  for (let i = rows.length; i < total; i++) {
    const cat = i % 3 === 0;
    rows.push({ kind: cat ? "CATEGORY" : "SERVICE_TYPE", id: cat ? String(100 + i) : `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `Заявка ${i}`, displayName: cat ? `Категорія ${i}` : null, categoryName: cat ? null : "brows", initialServiceName: cat ? `Послуга ${i}` : null, description: cat ? null : "Короткий опис заявки для перевірки розмітки.", requesterLabel: `Салон ${i}`, createdAt: new Date(Date.UTC(2026, 10, 1) + i * 3_600_000).toISOString(), status: "PENDING" });
  }
  const calls = [];
  const send = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const err = (res, status, code) => send(res, status, { success: false, data: code ? { code } : null, message: "CANARY-BACKEND-MESSAGE" });
  const server = createServer(async (rq, rs) => {
    const chunks = []; for await (const c of rq) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(rq.url, "http://mock");
    const actor = rq.headers["x-admin-actor"];
    calls.push({ method: rq.method, path: url.pathname + url.search, actor, key: rq.headers["x-internal-key"], body: raw ? JSON.parse(raw) : null });
    if (rq.headers["x-internal-key"] !== KEY) return err(rs, 401);
    if (!actor) return err(rs, 400);
    const live = handleCatalog(catalog, rq.method, url.pathname, raw, send, err, rs);
    if (live) return;
    if (rq.method === "GET" && url.pathname === "/api/v1/internal/catalog/requests") {
      const all = rows.filter((r) => r.status === (url.searchParams.get("status") ?? "PENDING"));
      const size = Math.max(1, Number(url.searchParams.get("size")) || 20), page = Math.max(0, Number(url.searchParams.get("page")) || 0);
      const data = all.slice(page * size, page * size + size);
      return send(rs, 200, { success: true, data: { success: true, data, message: null, page, size, totalElements: all.length, totalPages: Math.ceil(all.length / size) }, message: null });
    }
    const m = /^\/api\/v1\/internal\/catalog\/requests\/(CATEGORY|SERVICE_TYPE)\/([^/]+)(?:\/(approve|reject))?$/.exec(url.pathname);
    const row = m && rows.find((r) => r.kind === m[1] && r.id === m[2]);
    if (!m || !row) return err(rs, 404);
    if (row.status !== "PENDING") return err(rs, 409, "REQUEST_NOT_PENDING");
    const body = raw ? JSON.parse(raw) : {};
    if (rq.method === "PATCH") {
      if (/[^\p{L}\p{N} '’\-.,()]/u.test(body.name ?? "!")) return err(rs, 400);
      if (body.name === "dup") return err(rs, 409, "DUPLICATE_PENDING");
      if (body.name === "exists") return err(rs, 409, "TYPE_EXISTS");
      row[row.kind === "CATEGORY" ? "displayName" : "name"] = body.name;
      if (row.kind === "CATEGORY" && body.initialServiceName !== undefined) row.initialServiceName = body.initialServiceName || null;
      return send(rs, 200, { success: true, data: null, message: null });
    }
    if (rq.method === "POST" && m[3]) {
      if (m[3] === "approve" && (row.displayName ?? row.name) === "noicon") return err(rs, 409, "CATEGORY_ICON_REQUIRED");
      row.status = m[3] === "approve" ? "APPROVED" : "REJECTED";
      return send(rs, 200, { success: true, data: null, message: null });
    }
    return err(rs, 404);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
}

const NAME_BAD = /[^\p{L}\p{N} '’\-.,()]/u;
const catDto = (catalog, c) => ({ name: c.name, displayName: c.displayName, status: c.status, active: c.active, usageCount: c.usage, typeCount: catalog.types.get(c.name).length });
/** The B504/B505 endpoints; returns true when it answered. */
function handleCatalog(catalog, method, path, raw, send, err, rs) {
  const P = "/api/v1/internal/catalog/";
  if (!path.startsWith(P)) return false;
  const rest = path.slice(P.length);
  const ok = (data = null) => send(rs, 200, { success: true, data, message: null });
  let m;
  if (method === "GET" && rest === "categories") { ok(catalog.cats.map((c) => catDto(catalog, c))); return true; }
  if ((m = /^categories\/([^/]+)\/service-types$/.exec(rest)) && method === "GET") {
    const list = catalog.types.get(decodeURIComponent(m[1]));
    if (!list) err(rs, 404); else ok(list.map((x) => ({ id: x.id, slug: x.slug, nameUk: x.nameUk, nameEn: x.nameEn, active: x.active, usageCount: x.usage })));
    return true;
  }
  const body = raw ? JSON.parse(raw) : {};
  if ((m = /^categories\/([^/]+)$/.exec(rest))) {
    const c = catalog.cats.find((x) => x.name === decodeURIComponent(m[1]));
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(decodeURIComponent(m[1]))) { err(rs, 400); return true; }
    if (!c) { err(rs, 404); return true; }
    if (method === "PATCH") {
      if (body.displayName === undefined && body.active === undefined) { err(rs, 400); return true; }
      if (c.status !== "APPROVED") { err(rs, 409, "CATEGORY_NOT_APPROVED"); return true; }
      if (body.displayName !== undefined) {
        if (!body.displayName.trim() || body.displayName.length > 100 || NAME_BAD.test(body.displayName)) { err(rs, 400); return true; }
        if (catalog.cats.some((x) => x !== c && x.displayName.toLowerCase() === body.displayName.toLowerCase())) { err(rs, 409, "CATEGORY_NAME_EXISTS"); return true; }
      }
      if (body.active === true && c.displayName === "Без іконки") { err(rs, 409, "CATEGORY_ICON_REQUIRED"); return true; }
      if (body.displayName !== undefined) c.displayName = body.displayName;
      if (body.active !== undefined) c.active = body.active;
      ok(); return true;
    }
    if (method === "DELETE") {
      if (c.status !== "APPROVED") { err(rs, 409, "CATEGORY_NOT_APPROVED"); return true; }
      const types = catalog.types.get(c.name).length;
      if (types > 0 || c.usage > 0) { send(rs, 409, { success: false, data: { code: "CATALOG_IN_USE", serviceTypes: types, definitions: c.usage, pendingSuggestions: 0 }, message: "CANARY-BACKEND-MESSAGE" }); return true; }
      catalog.cats.splice(catalog.cats.indexOf(c), 1); catalog.types.delete(c.name);
      rs.writeHead(204); rs.end(); return true;
    }
    return false;
  }
  if ((m = /^service-types\/([^/]+)$/.exec(rest))) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m[1])) { err(rs, 400); return true; }
    let owner = null, t = null;
    for (const [name, list] of catalog.types) { const f = list.find((x) => x.id === m[1]); if (f) { owner = name; t = f; } }
    if (!t) { err(rs, 404); return true; }
    if (method === "PATCH") {
      if (body.nameUk === undefined && body.nameEn === undefined && body.active === undefined) { err(rs, 400); return true; }
      for (const n of [body.nameUk, body.nameEn]) if (n !== undefined && (n.length > 100 || NAME_BAD.test(n))) { err(rs, 400); return true; }
      if (body.nameUk !== undefined && !body.nameUk.trim()) { err(rs, 400); return true; }
      if (body.nameUk !== undefined && catalog.types.get(owner).some((x) => x !== t && x.nameUk.toLowerCase() === body.nameUk.toLowerCase())) { err(rs, 409, "TYPE_EXISTS"); return true; }
      for (const [k, f] of [["nameUk", "nameUk"], ["nameEn", "nameEn"], ["active", "active"]]) if (body[k] !== undefined) t[f] = body[k];
      ok(); return true;
    }
    if (method === "DELETE") {
      if (t.usage > 0) { send(rs, 409, { success: false, data: { code: "CATALOG_IN_USE", definitions: t.usage }, message: "CANARY-BACKEND-MESSAGE" }); return true; }
      catalog.types.get(owner).splice(catalog.types.get(owner).indexOf(t), 1);
      rs.writeHead(204); rs.end(); return true;
    }
  }
  return false;
}
