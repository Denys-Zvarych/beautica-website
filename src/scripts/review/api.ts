// Typed calls of the guest review page (phase 019). Kept out of booking/api.ts so the booking pages do not carry review code;
// the shared low-level `call` / `post` come from there.
import { call, post, type Result } from "../booking/api";

export interface ReviewSubmission {
  turnstileToken: string | null;
  /** One entry per service of the visit; `comment` null where the guest wrote none. */
  items: { bookingId: string; rating: number; comment: string | null }[];
}

/**
 * POST /api/v1/public/review-invites/{token}/reviews (backend 401): 201 { created }. The token is the credential (no OTP, no bearer); it only
 * travels in this path. 404 = spent / expired (`not-found`), 409 = a booking already reviewed (`conflict`), 400 = validation / Turnstile.
 */
export function submitReview(api: string, token: string, b: ReviewSubmission): Promise<Result<true>> {
  const body = { ...(b.turnstileToken ? { turnstileToken: b.turnstileToken } : {}), items: b.items.map((i) => ({ bookingId: i.bookingId, rating: i.rating, ...(i.comment ? { comment: i.comment } : {}) })) };
  return call(`${api}/api/v1/public/review-invites/${encodeURIComponent(token)}/reviews`, post(body), () => true);
}

/** POST /api/v1/public/review-invites/{token}/opt-out (backend 401): 204, idempotent. */
export function optOutReviews(api: string, token: string, turnstileToken: string | null): Promise<Result<true>> {
  return call(`${api}/api/v1/public/review-invites/${encodeURIComponent(token)}/opt-out`, post(turnstileToken ? { turnstileToken } : {}), () => true);
}
