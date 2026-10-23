// Booking-link channel flag (phase 013, research-short-booking-link-attribution.md). The app shares `?s=c` (copy) or `?s=s` (share).
// Read client-side only, so the SSR HTML and the edge cache key never depend on it. Any other value counts as absent and is never echoed.
import { setLinkContext, track, type LinkContext } from "../track";

export function parseChannel(pathname: string, search: string): LinkContext {
  const s = new URLSearchParams(search).get("s");
  return { kind: pathname.startsWith("/book/s/") ? "salon" : "master", source: s === "c" ? "copy" : s === "s" ? "share" : "none" };
}

/** Reads the flag, removes a valid one from the address bar (other params and history.state stay), registers the context. */
export function initChannel(): LinkContext {
  const ctx = parseChannel(location.pathname, location.search);
  setLinkContext(ctx); // first: nothing below may stop the context or the rest of main.ts
  if (ctx.source !== "none") {
    try {
      const url = new URL(location.href);
      url.searchParams.delete("s");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    } catch {
      /* the flag stays in the address bar; tracking and the page carry on */
    }
  }
  track("link_open", { referrer_host: referrerHost() });
  return ctx;
}

/** Lowercased hostname of the referrer, max 60 chars, no path/query; "" when absent, unparsable or our own origin. */
export function referrerHost(): string {
  try {
    if (!document.referrer) return "";
    const h = new URL(document.referrer).hostname.toLowerCase();
    return h === location.hostname.toLowerCase() ? "" : h.slice(0, 60);
  } catch {
    return "";
  }
}
