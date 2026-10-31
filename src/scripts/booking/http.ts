// Shared low-level call of the public booking API (split out of api.ts so a page that needs only a few calls, e.g. the guest cancel page,
// does not carry the booking-flow code). Credential-less fetches with a timeout; every outcome is mapped to a small union.
export type Fail = "validation" | "unauthorized" | "conflict" | "provider-unavailable" | "rate-limited" | "unavailable" | "not-found" | "network" | "error";
/** `status`: the HTTP status of a failed answer (absent for network / unreadable-body failures). */
export type Result<T> = { ok: true; data: T } | { ok: false; fail: Fail; status?: number };

const TIMEOUT_MS = 15000;

/** `code`: the stable `data.code` of an error body. 409 + `BOOKING_UNAVAILABLE` (booking create only, backend 398) is the neutral «blocked» answer; every other 409 stays a slot conflict. */
export function failFor(status: number, code?: unknown): Fail {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 409) return code === "BOOKING_UNAVAILABLE" ? "provider-unavailable" : "conflict";
  if (status === 429) return "rate-limited";
  if (status === 404) return "not-found";
  if (status === 400 || status === 422) return "validation";
  if (status === 503 || status === 502 || status === 504) return "unavailable";
  return "error";
}

/** Shared low-level call (also used by the review page script and the Telegram calls). `mapBlocked`: opt-in to the 409 `BOOKING_UNAVAILABLE` mapping (the booking-create calls only); everywhere else a 409 stays a plain conflict. */
export async function call<T>(url: string, init: RequestInit, read: (json: unknown) => T | null, mapBlocked = false): Promise<Result<T>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { ok: false, fail: "network" };
  }
  if (!res.ok) {
    let code: unknown;
    if (mapBlocked && res.status === 409) {
      try {
        code = obj(obj(await res.json()).data).code;
      } catch {
        /* a 409 without a readable body is a plain conflict */
      }
    }
    return { ok: false, fail: failFor(res.status, code), status: res.status };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* an empty body is fine for some endpoints */
  }
  const data = read(json);
  return data === null ? { ok: false, fail: "error" } : { ok: true, data };
}

export const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
export const post = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

