// Typed calls to the public booking API (PublicBookingController + PhoneOtpController). Credential-less fetches with a timeout;
// every outcome is mapped to a small union, so the UI never inspects status codes. No PII is ever logged.
export type Fail = "validation" | "unauthorized" | "conflict" | "rate-limited" | "unavailable" | "not-found" | "network" | "error";
export type Result<T> = { ok: true; data: T } | { ok: false; fail: Fail };

export interface Slot {
  startsAt: string;
  endsAt: string;
}
export interface BookingCreated {
  startsAt: string;
  masterName: string;
  serviceName: string;
  durationMinutes: number;
  cancelUrl: string | null;
}
export interface BookingRequest {
  serviceIds: string[];
  startsAt: string;
  name: string;
  surname: string;
  policyVersion: string;
  /** Optional note for the master (backend phase 385: at most 1000 chars). Omitted when blank. */
  clientComment?: string;
}

const TIMEOUT_MS = 15000;

export function failFor(status: number): Fail {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 409) return "conflict";
  if (status === 429) return "rate-limited";
  if (status === 404) return "not-found";
  if (status === 400 || status === 422) return "validation";
  if (status === 503 || status === 502 || status === 504) return "unavailable";
  return "error";
}

async function call<T>(url: string, init: RequestInit, read: (json: unknown) => T | null): Promise<Result<T>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { ok: false, fail: "network" };
  }
  if (!res.ok) return { ok: false, fail: failFor(res.status) };
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* an empty body is fine for some endpoints */
  }
  const data = read(json);
  return data === null ? { ok: false, fail: "error" } : { ok: true, data };
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const post = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

export function getAvailability(api: string, slug: string, day: string, serviceIds: string[]): Promise<Result<Slot[]>> {
  const q = new URLSearchParams({ date: day });
  for (const id of serviceIds) q.append("serviceId", id);
  return call(`${api}/api/v1/book/${slug}/availability?${q}`, { headers: { Accept: "application/json" } }, (j) =>
    Array.isArray(j) ? j.flatMap((s) => (typeof obj(s).startsAt === "string" && typeof obj(s).endsAt === "string" ? [{ startsAt: obj(s).startsAt as string, endsAt: obj(s).endsAt as string }] : [])) : null,
  );
}

export function sendOtp(api: string, phone: string, policyVersion: string, turnstileToken: string | null): Promise<Result<true>> {
  return call(`${api}/api/v1/book/otp/send`, post({ phone, privacyAccepted: true, privacyPolicyVersion: policyVersion, ...(turnstileToken ? { turnstileToken } : {}) }), () => true);
}

export function verifyOtp(api: string, phone: string, code: string): Promise<Result<string>> {
  return call(`${api}/api/v1/book/otp/verify`, post({ phone, code }), (j) => {
    const t = obj(obj(j).data).guestToken;
    return typeof t === "string" && t ? t : null;
  });
}

export function createBooking(api: string, slug: string, guestToken: string, b: BookingRequest): Promise<Result<BookingCreated>> {
  const ids = b.serviceIds.length === 1 ? { serviceId: b.serviceIds[0] } : { masterServiceIds: b.serviceIds };
  const body = { ...ids, startsAt: b.startsAt, name: b.name, surname: b.surname, privacyAccepted: true, privacyPolicyVersion: b.policyVersion, ...(b.clientComment ? { clientComment: b.clientComment } : {}) };
  return call(`${api}/api/v1/book/${slug}/booking`, post(body, guestToken), (j) => {
    const o = obj(j);
    return typeof o.startsAt === "string"
      ? { startsAt: o.startsAt, masterName: String(o.masterName ?? ""), serviceName: String(o.serviceName ?? ""), durationMinutes: Number(o.durationMinutes ?? 0), cancelUrl: typeof o.cancelUrl === "string" ? o.cancelUrl : null }
      : null;
  });
}

/** The cancel page lives on this site: keep only the `/book/cancel/{uuid}` path of whatever origin the backend put in the URL. */
export function cancelPath(cancelUrl: string | null): string | null {
  if (!cancelUrl) return null;
  try {
    const p = new URL(cancelUrl, "https://beautica.app").pathname;
    return /^\/book\/cancel\/[0-9a-f-]{36}$/i.test(p) ? p : null;
  } catch {
    return null;
  }
}
