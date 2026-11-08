// Typed calls to the public booking API (PublicBookingController + PhoneOtpController). Credential-less fetches with a timeout;
// every outcome is mapped to a small union, so the UI never inspects status codes. No PII is ever logged.
export type { Fail, Result } from "./http.ts";
import type { Fail, Result } from "./http.ts";
export interface Slot {
  startsAt: string;
  endsAt: string;
}
export interface BookableDay {
  date: string;
  /** false = no free time that day for the chosen services (the calendar greys it out). */
  working: boolean;
}
export interface BookingCreated {
  startsAt: string;
  masterName: string;
  serviceName: string;
  durationMinutes: number;
  cancelUrl: string | null;
  /** Backend 407 D6: the Telegram reminder channel for the booker's phone. `null` = field absent / malformed = no choice is offered. */
  telegram: TelegramAvailability | null;
}
export interface TelegramAvailability {
  available: boolean;
  linked: boolean;
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

export { failFor, call, post } from "./http.ts";
import { call, post, obj } from "./http.ts";

/** `/book/{slug}` for a master link; `/book/s/{slug}/masters/{masterId}` for one master of a salon link (backend 392/393: salon masters have no link of their own). */
const scope = (api: string, slug: string, masterId?: string): string =>
  masterId ? `${api}/api/v1/book/s/${encodeURIComponent(slug)}/masters/${encodeURIComponent(masterId)}` : `${api}/api/v1/book/${encodeURIComponent(slug)}`;

export function getAvailability(api: string, slug: string, day: string, serviceIds: string[], masterId?: string): Promise<Result<Slot[]>> {
  const q = new URLSearchParams({ date: day });
  for (const id of serviceIds) q.append("serviceId", id);
  return call(`${scope(api, slug, masterId)}/availability?${q}`, { headers: { Accept: "application/json" } }, (j) =>
    Array.isArray(j) ? j.flatMap((s) => (typeof obj(s).startsAt === "string" && typeof obj(s).endsAt === "string" ? [{ startsAt: obj(s).startsAt as string, endsAt: obj(s).endsAt as string }] : [])) : null,
  );
}

/** GET /book/{slug}/bookable-days (backend 387): per day of [from, to] (inside today ... today+60, Kyiv), whether the chosen services fit. */
export function getBookableDays(api: string, slug: string, from: string, to: string, serviceIds: string[], masterId?: string): Promise<Result<BookableDay[]>> {
  const q = new URLSearchParams({ from, to });
  for (const id of serviceIds) q.append("serviceId", id);
  return call(`${scope(api, slug, masterId)}/bookable-days?${q}`, { headers: { Accept: "application/json" } }, (j) =>
    Array.isArray(j) ? j.flatMap((d) => (typeof obj(d).date === "string" && typeof obj(d).working === "boolean" ? [{ date: obj(d).date as string, working: obj(d).working as boolean }] : [])) : null,
  );
}

export function sendOtp(api: string, phone: string, policyVersion: string, turnstileToken: string | null, smsFormat?: OtpSmsFormat): Promise<Result<true>> {
  return call(`${api}/api/v1/book/otp/send`, post({ phone, privacyAccepted: true, privacyPolicyVersion: policyVersion, ...(turnstileToken ? { turnstileToken } : {}), ...(smsFormat ? { smsFormat } : {}) }), () => true);
}

export function verifyOtp(api: string, phone: string, code: string): Promise<Result<string>> {
  return call(`${api}/api/v1/book/otp/verify`, post({ phone, code }), (j) => {
    const t = obj(obj(j).data).guestToken;
    return typeof t === "string" && t ? t : null;
  });
}

export function createBooking(api: string, slug: string, guestToken: string, b: BookingRequest, masterId?: string): Promise<Result<BookingCreated>> {
  // The salon route takes `masterServiceIds` always (1-10); the master link keeps `serviceId` for a single service.
  const ids = b.serviceIds.length === 1 && !masterId ? { serviceId: b.serviceIds[0] } : { masterServiceIds: b.serviceIds };
  const body = { ...ids, startsAt: b.startsAt, name: b.name, surname: b.surname, privacyAccepted: true, privacyPolicyVersion: b.policyVersion, ...(b.clientComment ? { clientComment: b.clientComment } : {}) };
  return call(
    `${scope(api, slug, masterId)}/booking`,
    post(body, guestToken),
    (j) => {
      const o = obj(j);
      return typeof o.startsAt === "string"
        ? { startsAt: o.startsAt, masterName: String(o.masterName ?? ""), serviceName: String(o.serviceName ?? ""), durationMinutes: Number(o.durationMinutes ?? 0), cancelUrl: typeof o.cancelUrl === "string" ? o.cancelUrl : null, telegram: readTelegram(o.telegram) }
        : null;
    },
    true,
  );
}

/** The `telegram {available, linked}` block of a booking response; anything else (absent, wrong types) is `null` = no choice shown. */
export function readTelegram(v: unknown): TelegramAvailability | null {
  const o = obj(v);
  return typeof o.available === "boolean" && typeof o.linked === "boolean" ? { available: o.available, linked: o.linked } : null;
}

export * from "./cancel-path.ts";

export * from "./telegram-api.ts";
