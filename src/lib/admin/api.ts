// Server-side proxy helper to the backend's internal catalog API (phase 039, D2). The scoped key lives in the Worker env and goes
// out as `X-Internal-Key`; the browser never sees it. W040/W041 call this for every backend request.
import type { AdminConfig } from "./config.ts";

export const CATALOG_PREFIX = "/api/v1/internal/catalog/";
const TIMEOUT_MS = 10_000;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,189}$/;

export type AdminResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; code: string; message: string };

const MESSAGES: Record<string, string> = {
  REQUEST_NOT_PENDING: "Заявку вже опрацьовано.",
  DUPLICATE_PENDING: "Заявка з такою назвою вже очікує розгляду.",
  TYPE_EXISTS: "Тип послуги з такою назвою вже існує.",
  CATALOG_IN_USE: "Неможливо видалити: елемент каталогу використовується. Сховайте його.",
};

/** Ukrainian message for a backend failure. A typed 409 never falls back to the generic server error. */
export function errorMessage(status: number, code: string): string {
  if (MESSAGES[code]) return MESSAGES[code];
  if (status === 409) return "Конфлікт: дані вже змінено. Оновіть сторінку.";
  if (status === 400) return "Некоректні дані. Перевірте поля.";
  if (status === 401 || status === 403) return "Бекенд відхилив ключ доступу.";
  if (status === 404) return "Не знайдено.";
  if (status === 0) return "Бекенд не відповідає. Спробуйте пізніше.";
  return status >= 500 ? "Помилка сервера. Спробуйте пізніше." : "Не вдалося виконати запит.";
}

/** Only paths under /api/v1/internal/catalog/, no traversal, no scheme/host tricks. */
export function assertCatalogPath(path: string): void {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error("adminFetch: bad path");
  }
  const bad = !path.startsWith(CATALOG_PREFIX) || path.length === CATALOG_PREFIX.length || /[\\#\u0000-\u001f]/.test(decoded) || decoded.split(/[/?]/).includes("..") || decoded.includes("//") || path.includes("//");
  if (bad) throw new Error("adminFetch: path outside /api/v1/internal/catalog/");
}

export async function adminFetch(cfg: AdminConfig, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, actor: string, body?: unknown): Promise<AdminResult> {
  assertCatalogPath(path);
  if (!EMAIL.test(actor) || actor.length > 254) throw new Error("adminFetch: bad actor");
  const headers: Record<string, string> = { Accept: "application/json", "X-Internal-Key": cfg.catalogKey, "X-Admin-Actor": actor };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${cfg.apiOrigin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
  } catch {
    return { ok: false, status: 0, code: "UNAVAILABLE", message: errorMessage(0, "") };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (res.ok) return { ok: true, status: res.status, data: (json as { data?: unknown } | null)?.data ?? json };
  return { ok: false, status: res.status, code: errorCode(json), message: errorMessage(res.status, errorCode(json)) };
}

/** Typed code of an error envelope: `code`, `errorCode`, `data.code` or an UPPER_SNAKE `message` (B502+ fix the exact field). */
function errorCode(json: unknown): string {
  const j = json as { code?: unknown; errorCode?: unknown; message?: unknown; data?: { code?: unknown } | null } | null;
  for (const v of [j?.code, j?.errorCode, j?.data?.code, j?.message]) if (typeof v === "string" && /^[A-Z][A-Z0-9_]{2,60}$/.test(v)) return v;
  return "";
}
