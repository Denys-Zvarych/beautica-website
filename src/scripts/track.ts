// Funnel events (README § 10), sent to Umami (phase 007). Umami is injected after load + idle, so an event fired on load
// (`link_open`) runs before `window.umami` exists: it waits in a small queue, flushed when the Umami script has loaded.
// Props are counts and codes only: never a name, phone, token or booking id. Anything outside the allow-list is dropped.
type Props = Record<string, string | number>;

/** README § 10: the only events, each with the only props it may carry (`kind` / `source` are added from the link context). */
export const EVENTS: Readonly<Record<string, readonly string[]>> = {
  store_click: ["store", "placement"],
  link_open: ["referrer_host"],
  profile_view: ["slug"],
  service_selected: ["count"],
  slot_selected: ["days_ahead"],
  otp_requested: [],
  otp_verified: [],
  otp_failed: [],
  booking_confirmed: ["services_count"],
  booking_error: ["code"],
  install_prompt_click: [],
  reminder_channel_telegram_click: [],
  reminder_channel_unlink: [],
};

// Channel of the booking link the visitor came from (phase 013): `kind` from the path, `source` from the 1-char `?s=` flag.
// Set once by booking/channel.ts; merged into every event so the Umami funnel splits by copy / share (README § 10).
export type LinkContext = { kind: "master" | "salon"; source: "copy" | "share" | "none" };
let linkContext: LinkContext | null = null;
export const setLinkContext = (c: LinkContext): void => void (linkContext = c);
export const getLinkContext = (): LinkContext | null => linkContext;

type Umami = { track?: (e: string, p?: Props) => void };
const umami = (): Umami | undefined => (window as unknown as { umami?: Umami }).umami;

// Umami arrives after load + idle (analytics.ts): events fired before that wait here (max 20, one 20 s cap), flushed when its script loads
// (`beautica:umami`, detail true) and dropped on error / cap. `null` = settled, nothing is queued any more. Only pages that carry the
// Layout marker meta (never token routes) queue at all.
let queue: Array<() => void> | null = [];
let cap: ReturnType<typeof setTimeout> | undefined;
const settle = (ok: boolean): void => {
  clearTimeout(cap);
  const q = queue;
  queue = null;
  if (ok) q?.forEach((fn) => fn());
};
document.addEventListener("beautica:umami", (e) => settle((e as CustomEvent<boolean>).detail === true));

export function track(event: string, props?: Props): void {
  if (!Object.hasOwn(EVENTS, event)) return;
  const p: Props = {};
  for (const k of EVENTS[event]) if (props && k in props) p[k] = typeof props[k] === "string" ? String(props[k]).slice(0, 60) : props[k];
  const out = linkContext ? { ...p, ...linkContext } : Object.keys(p).length ? p : undefined;
  const send = (): void => {
    try {
      umami()?.track?.(event, out); // analytics must never break the flow
    } catch {
      /* ignore */
    }
  };
  if (umami()?.track) send();
  else if (queue && queue.length < 20 && document.querySelector("meta[name=beautica-analytics]")) {
    queue.push(send);
    cap ??= setTimeout(() => settle(false), 20000);
  }
}

let clicks = false;
/** One delegated listener for `data-event="store_click" data-store="google_play" data-placement="hero"` (and any README § 10 event). */
export function initClickEvents(): void {
  if (clicks) return;
  clicks = true;
  document.addEventListener("click", (e) => {
    const el = (e.target as Element | null)?.closest?.("[data-event]") as HTMLElement | null;
    const name = el?.dataset.event;
    if (!el || !name || !Object.hasOwn(EVENTS, name)) return;
    const props: Props = {};
    for (const k of EVENTS[name]) if (el.dataset[k] !== undefined) props[k] = el.dataset[k]!.slice(0, 60);
    track(name, props);
  });
}
