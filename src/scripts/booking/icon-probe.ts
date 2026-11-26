// Remote category icons (server iconUrl, W050). Elements carry data-remote (the icon) + data-fallback (the bundled one) and NO data-src, so
// hydrateIcons (main.js) never touches them. Each URL is probed once with the same CORS mode as a mask fetch (blocked host or missing CORS
// rule -> the bundled icon); rows sharing an icon share the probe.
const probes = new Map<string, Promise<boolean>>();
const probe = (src: string): Promise<boolean> => {
  let p = probes.get(src);
  if (!p) {
    p = new Promise<boolean>((res) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => res(true);
      img.onerror = () => res(false);
      img.src = src;
    });
    probes.set(src, p);
  }
  return p;
};
const seen = new WeakSet<Element>();
export function probeRemote(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>(".ai[data-remote]:not([data-ready])").forEach((e) => {
    if (seen.has(e)) return;
    seen.add(e);
    void probe(e.dataset.remote!).then((ok) => {
      e.style.setProperty("--src", `url(${ok ? e.dataset.remote : e.dataset.fallback})`);
      e.setAttribute("data-ready", "");
    });
  });
}
