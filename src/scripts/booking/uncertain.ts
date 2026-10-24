// A booking POST whose outcome is unknown (phase 016 audit): the booking MAY exist. Shared by the master link and the salon wizard so both
// apply the one rule: the slot is frozen, the only legal move is to send the SAME slot again, never another time (that could book the
// guest twice), and a 409 on that resend reads «probably booked by you, check your SMS».
import type { Fail, Slot } from "./api";
import { errorOutline } from "../../lib/icons/materialPaths";

/** A dropped connection, an unreadable 2xx answer, or a gateway timeout (502 / 504): the request may have been processed. 503 is a clear «no». */
export function isAmbiguous(r: { fail: Fail; status?: number }): boolean {
  return r.fail === "network" || r.fail === "error" || r.status === 502 || r.status === 504;
}
/** Is this failure to be read as «the booking may exist»? A new ambiguous failure, or ANY failure of a resend after one (401 is its own path). */
export function mayExist(r: { fail: Fail; status?: number }, prior: boolean): boolean {
  return r.fail !== "unauthorized" && (isAmbiguous(r) || prior);
}
/** The frozen slots, per key (a master id; the master link uses ""). */
export function createLedger() {
  const m = new Map<string, { slot: Slot; day: string }>();
  return {
    get: (k: string) => m.get(k),
    has: (k: string) => m.has(k),
    set: (k: string, v: { slot: Slot; day: string }) => void m.set(k, v),
    delete: (k: string) => m.delete(k),
    get size() {
      return m.size;
    },
  };
}

// ---- Survives a reload (sessionStorage, this tab only). A reload loses the frozen slot above; without a trace the guest could verify the phone
// again and book ANOTHER time while the first request exists. The marker is minimal and carries no personal data: never a phone, name, note
// or token, only which master (salon links), the slot's start, a short label of the time and when it was stored. 15 minutes, then it is gone.
// Every storage access is guarded: with storage blocked or full the page works as before (the freeze just stays in memory).
export type LinkKind = "master" | "salon";
export interface Marker {
  masterId?: string;
  slotStartIso: string;
  label: string;
  at: number;
}
export const MARKER_TTL_MS = 15 * 60 * 1000;
const MAX_RAW = 1024; // the whole stored string
const MAX_LABEL = 200;
const MAX_ID = 64; // masterId, slotStartIso
export const markerKey = (kind: LinkKind, slug: string): string => `bk-unsure:${kind}:${slug}`;

export function saveMarker(kind: LinkKind, slug: string, m: Omit<Marker, "at">): void {
  try {
    sessionStorage.setItem(markerKey(kind, slug), JSON.stringify({ ...m, at: Date.now() } satisfies Marker));
  } catch {
    /* storage blocked or full: the in-memory freeze still applies */
  }
}
export function clearMarker(kind: LinkKind, slug: string): void {
  try {
    sessionStorage.removeItem(markerKey(kind, slug));
  } catch {
    /* nothing to clear */
  }
}
/** The fresh marker of this link, or null (missing, malformed, from another time, older than 15 minutes: the last three are also removed). */
export function readMarker(kind: LinkKind, slug: string): Marker | null {
  try {
    const raw = sessionStorage.getItem(markerKey(kind, slug));
    if (!raw) return null;
    // Anything this module did not write (a foreign script, a hand-edited value) is ignored and removed: bounded sizes, right types, not expired.
    const v = raw.length <= MAX_RAW ? (JSON.parse(raw) as Partial<Marker>) : {};
    const fresh =
      typeof v.at === "number" &&
      typeof v.slotStartIso === "string" && v.slotStartIso.length <= MAX_ID &&
      typeof v.label === "string" && v.label.length <= MAX_LABEL &&
      (v.masterId === undefined || (typeof v.masterId === "string" && v.masterId.length <= MAX_ID)) &&
      Date.now() - v.at >= 0 && Date.now() - v.at < MARKER_TTL_MS;
    if (!fresh) {
      sessionStorage.removeItem(markerKey(kind, slug));
      return null;
    }
    return { slotStartIso: v.slotStartIso!, label: v.label!, at: v.at!, ...(typeof v.masterId === "string" ? { masterId: v.masterId } : {}) };
  } catch {
    return null;
  }
}

/** The page-load notice: «Можливо, ви вже записані на …» with «Зрозуміло» (clears the marker). The page's own .banner look, no new component.
 *  The strings come from the page (`data-unsure`, `data-unsure-ok`), so the markup holds no copy. */
export function showMarkerNotice(root: HTMLElement): void {
  const kind: LinkKind = root.dataset.mode === "salon" ? "salon" : "master";
  const slug = root.dataset.slug ?? "";
  const text = root.dataset.unsure;
  const ok = root.dataset.unsureOk;
  const marker = text && ok ? readMarker(kind, slug) : null;
  if (!marker || !text || !ok) return;
  const box = document.createElement("div");
  box.className = "banner unsure-note"; // the page's .banner look, laid over the page (position: fixed in book.css): it moves nothing
  box.id = "unsure-note";
  box.setAttribute("role", "status");
  box.innerHTML = `<svg class="mi" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${errorOutline}"></path></svg>`;
  const msg = document.createElement("span");
  msg.className = "t-fb";
  msg.textContent = `${text.replace("{label}", () => marker.label)} `;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "link-btn t-link link-hit";
  btn.textContent = ok;
  btn.addEventListener("click", () => {
    clearMarker(kind, slug);
    // Focus moves to the page heading first: removing the focused button would drop it to <body> (a keyboard / screen-reader user loses their place).
    const h1 = document.querySelector<HTMLElement>("h1");
    if (h1) {
      h1.tabIndex = -1;
      h1.focus({ preventScroll: true });
    }
    box.remove();
  });
  msg.append(btn);
  box.append(msg);
  root.prepend(box);
}
