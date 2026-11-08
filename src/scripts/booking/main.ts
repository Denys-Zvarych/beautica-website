// Entry for the booking-link pages. Everything is lazy: a page without the matching markup loads nothing extra, and the booking island
// (calendar, slots, OTP ... about 13 KB gz, 25 KB raw) is fetched when the visitor shows intent (touch / hover / focus on the button) or taps it.
import { track } from "../track";
import { hydrateIcons } from "./icons";
import { initChannel } from "./channel";
import { showMarkerNotice } from "./uncertain";
import { guardUrlSwitch } from "./booking-url";

initChannel();
guardUrlSwitch(); // phase 032: keeps the analytics beacon from seeing the done screen's token URL

if (document.readyState === "complete") hydrateIcons();
else window.addEventListener("load", () => setTimeout(() => hydrateIcons(), 0), { once: true });

const root = document.querySelector<HTMLElement>("[data-book-root]");
if (root) track("profile_view", { slug: root.dataset.slug ?? "" });
if (root?.hasAttribute("data-booking")) showMarkerNotice(root); // a booking request of unknown outcome from before a reload (phase 016)
if (document.querySelector("[data-tabs]")) void import("./tabs").then((m) => m.initTabs());
if (document.querySelector("[data-reviews]")) void import("./reviews").then((m) => m.initReviews());
if (document.getElementById("showall")) void import("./tabs").then((m) => m.initShowAll());
if (document.querySelector("[data-svc-filter]")) void import("./filter").then((m) => m.initFilter());

const cta = document.getElementById("book-cta");
if (root?.hasAttribute("data-booking") && cta) {
  // With script the button replaces the "needs JavaScript" note straight away; the heavy part loads on intent.
  document.querySelector("[data-nojs]")?.setAttribute("hidden", "");
  document.querySelector<HTMLElement>("[data-book-cta]")!.hidden = false;
  let island: Promise<{ open(): void }> | null = null;
  const salon = root.dataset.mode === "salon";
  // Salon link: the wizard module, its steps and the salon info all start at the first sign of intent, in parallel (the app chunk alone is not
  // enough). A failure (offline, API down) is shown under the button and the next tap tries again.
  const load = () =>
    (island ??= (async () => {
      if (salon) void import("./salon-info").then((m) => m.prefetch(root.dataset.api ?? "", root.dataset.slug ?? ""));
      const [app] = await Promise.all([import("./app"), ...(salon ? [import("./salon")] : [])]);
      return app.initBooking(root);
    })().catch((e) => {
      island = null;
      throw e;
    }));
  for (const ev of ["pointerenter", "touchstart", "focus"]) cta.addEventListener(ev, () => void load().catch(() => {}), { once: true, passive: true });
  cta.addEventListener("click", () => {
    void load().then(
      (i) => {
        document.getElementById("book-cta-error")?.remove();
        i.open();
      },
      () => {
        if (document.getElementById("book-cta-error")) return;
        const p = document.createElement("p");
        p.id = "book-cta-error";
        p.className = "t-fb err centered";
        p.setAttribute("role", "alert");
        p.textContent = document.querySelector<HTMLElement>("[data-book-cta]")?.dataset.error ?? "";
        cta.parentElement?.prepend(p);
      },
    );
  });
}
