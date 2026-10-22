// Entry for the booking-link pages. Everything is lazy: a page without the matching markup loads nothing extra.
if (document.querySelector("[data-tabs]")) void import("./tabs").then((m) => m.initTabs());
if (document.getElementById("showall")) void import("./tabs").then((m) => m.initShowAll());
