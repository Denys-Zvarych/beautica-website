// TEST-ONLY stand-in for the backend's internal catalog endpoints (B502/B503), used by scripts/render-admin.mjs so /admin/requests renders and its
// forms work with sample data. It is NOT reachable from src/: the harness just points the Worker's API_ORIGIN at it. Requires the scoped key + actor
// headers like the real guard (401 / 400). Magic names: "dup" -> 409 DUPLICATE_PENDING, a name with a non-letter symbol -> 400, "exists" -> 409 TYPE_EXISTS, "noicon" approve ->
// 409 CATEGORY_ICON_REQUIRED. State (rows, calls) is created per startCatalogMock() call and the server listens on port 0: runs never share anything. Decided requests leave the pending list; a second decision is 409 REQUEST_NOT_PENDING.
import { createServer } from "node:http";

const KEY = "test-catalog-key-0000000000000000000";
const seed = () => [
  { kind: "CATEGORY", id: "41", name: "Brow-bar", displayName: "Brow bar", categoryName: null, initialServiceName: "Ламінування брів", description: null, requesterLabel: "Салон «Лотос»", createdAt: "2026-11-10T09:15:00Z", status: "PENDING" },
  { kind: "SERVICE_TYPE", id: "5b0f3c1e-2d4a-4c1b-9a77-0a1b2c3d4e5f", name: "Корекція брів воском", displayName: null, categoryName: "brows", initialServiceName: null, description: "Часто просять клієнти.\nПотрібен окремий тип.", requesterLabel: "Олена Коваленко", createdAt: "2026-11-12T14:40:00Z", status: "PENDING" },
  { kind: "SERVICE_TYPE", id: "9c1d2e3f-4a5b-4c6d-8e7f-001122334455", name: "Нігті", displayName: null, categoryName: "nails", initialServiceName: null, description: null, requesterLabel: "—", createdAt: "2026-11-11T08:00:00Z", status: "PENDING" },
];

/** `rows` (env CATALOG_MOCK_ROWS) > 3 pads the sample data with generated requests (perf runs: 100 cards). */
export async function startCatalogMock(total = Number(process.env.CATALOG_MOCK_ROWS) || 0) {
  const rows = seed();
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
    calls.push({ method: rq.method, path: url.pathname + url.search, actor, body: raw ? JSON.parse(raw) : null });
    if (rq.headers["x-internal-key"] !== KEY) return err(rs, 401);
    if (!actor) return err(rs, 400);
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
