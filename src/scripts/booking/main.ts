// Entry for the booking-link pages. Everything is lazy: a page without the matching markup loads nothing extra.
import { track } from "../track";

const root = document.querySelector<HTMLElement>("[data-book-root]");
if (root) track("profile_view", { slug: root.dataset.slug ?? "" });
if (document.querySelector("[data-tabs]")) void import("./tabs").then((m) => m.initTabs());
if (document.querySelector("[data-reviews]")) void import("./reviews").then((m) => m.initReviews());
if (document.getElementById("showall")) void import("./tabs").then((m) => m.initShowAll());
if (root?.hasAttribute("data-booking")) void import("./app").then((m) => m.initBooking(root));
