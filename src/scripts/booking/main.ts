// Entry for the booking-link pages. Everything is lazy: a page without the matching markup loads nothing extra, and the booking island
// (calendar, slots, OTP ... about 25 KB) is fetched when the visitor shows intent (touch / hover / focus on the button) or taps it.
import { track } from "../track";
import { hydrateIcons } from "./icons";

if (document.readyState === "complete") hydrateIcons();
else window.addEventListener("load", () => setTimeout(() => hydrateIcons(), 0), { once: true });

const root = document.querySelector<HTMLElement>("[data-book-root]");
if (root) track("profile_view", { slug: root.dataset.slug ?? "" });
if (document.querySelector("[data-tabs]")) void import("./tabs").then((m) => m.initTabs());
if (document.querySelector("[data-reviews]")) void import("./reviews").then((m) => m.initReviews());
if (document.getElementById("showall")) void import("./tabs").then((m) => m.initShowAll());

const cta = document.getElementById("book-cta");
if (root?.hasAttribute("data-booking") && cta) {
  // With script the button replaces the "needs JavaScript" note straight away; the heavy part loads on intent.
  document.querySelector("[data-nojs]")?.setAttribute("hidden", "");
  document.querySelector<HTMLElement>("[data-book-cta]")!.hidden = false;
  let island: Promise<{ open(): void }> | null = null;
  const load = () => (island ??= import("./app").then((m) => m.initBooking(root)));
  for (const ev of ["pointerenter", "touchstart", "focus"]) cta.addEventListener(ev, () => void load(), { once: true, passive: true });
  cta.addEventListener("click", () => void load().then((i) => i.open()));
}
