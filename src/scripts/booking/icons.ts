// Category icons are CSS masks (/icons/category_*.svg). Their URLs are not in the first HTML (no request competes with the first paint);
// this sets them once the page has loaded, and again for the booking steps when they are adopted.
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>(".ai[data-src]:not([data-ready])").forEach((e) => {
    e.style.setProperty("--src", `url(${e.dataset.src})`);
    e.setAttribute("data-ready", "");
  });
}
