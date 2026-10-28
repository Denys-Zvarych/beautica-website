// Cloudflare Turnstile, loaded lazily at the contact step only (never on page load). Explicit render, one widget; the token is
// single-use, so it is cleared after every send and the widget reset.
const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Must equal the backend's `app.turnstile.expected-action` (application-prod.yml): the verifier rejects a token with any other action (400). */
export const TURNSTILE_ACTION = "otp_send";
/** Guest review page (/r/{token}): submit and opt-out. TODO(backend-401): `app.turnstile.expected-action` must accept this value for the review-invite routes. */
export const REVIEW_TURNSTILE_ACTION = "review_submit";

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;
function load(): Promise<TurnstileApi> {
  if (typeof window.turnstile?.render === "function") return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.onload = () => (typeof window.turnstile?.render === "function" ? resolve(window.turnstile) : reject(new Error("turnstile")));
    s.onerror = () => {
      loading = null;
      reject(new Error("turnstile"));
    };
    document.head.append(s);
  });
  return loading;
}

export interface Widget {
  /** Resolves with a fresh token, or null after `ms` (or when the widget failed). */
  token(ms: number): Promise<string | null>;
  /** Drop the used token and ask for a new one. */
  reset(): void;
}

export async function mountTurnstile(el: HTMLElement, siteKey: string, action: string = TURNSTILE_ACTION): Promise<Widget | null> {
  let api: TurnstileApi;
  try {
    api = await load();
  } catch {
    return null;
  }
  let current: string | null = null;
  const waiters: ((t: string | null) => void)[] = [];
  const settle = (t: string | null) => {
    current = t;
    if (t) while (waiters.length) waiters.shift()!(t);
  };
  const id = api.render(el, {
    sitekey: siteKey,
    theme: "light",
    language: "uk",
    action,
    callback: (t: string) => settle(t),
    "expired-callback": () => settle(null),
    "error-callback": () => settle(null),
  });
  return {
    token: (ms) =>
      current
        ? Promise.resolve(current)
        : new Promise((resolve) => {
            waiters.push(resolve);
            setTimeout(() => resolve(null), ms);
          }),
    reset: () => {
      current = null;
      api.reset(id);
    },
  };
}
