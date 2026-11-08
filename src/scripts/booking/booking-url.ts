// Phase 032: the done screen's own address (kept apart from the calendar chooser: the booking pages call it on success, the chooser is not needed for it).
let switching = false;

/** Registered from main.ts at page load, i.e. BEFORE the analytics loader injects the Cloudflare beacon (1.5 s after load): the beacon listens to the Navigation API
 *  `navigate` event (also fired by our own replaceState) and would report the token URL as a page view. While we switch the address this listener (first in line) stops the event. */
export function guardUrlSwitch(): void {
  (window as { navigation?: EventTarget }).navigation?.addEventListener("navigate", (e) => {
    if (switching) e.stopImmediatePropagation();
  });
}

/** Phase 032: the done screen gets the booking's own token URL, so «open in the external browser» lands on the booking, not the master profile.
 *  The NATIVE replaceState is used on purpose: Umami / the Cloudflare beacon wrap `history.replaceState` on the instance and would report the token URL. */
export function showBookingUrl(cancelPathValue: string | null): void {
  if (!cancelPathValue || !/^\/(c\/[0-9A-Za-z]{16}|book\/cancel\/[0-9a-f-]{36})$/i.test(cancelPathValue)) return;
  try {
    // The token path would otherwise ride along as the Referer of every later same-origin request (images, the .ics link): no referrer from here on (added once).
    if (!document.head.querySelector('meta[name="referrer"][content="no-referrer"]')) {
      const m = document.createElement("meta");
      m.name = "referrer";
      m.content = "no-referrer";
      document.head.append(m);
    }
    switching = true;
    History.prototype.replaceState.call(history, { bk: "done" }, "", `${cancelPathValue}?n=1`);
  } catch {
    /* the address stays as it is; the done card is unaffected */
  } finally {
    switching = false;
  }
}
