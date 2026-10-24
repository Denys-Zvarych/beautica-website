// Salon page, «Послуги» tab (phase 017, like the app's salonServiceFilterProvider): a tap on a service filters the «Майстри» tab to the
// masters who perform it and opens that tab; a tap on the active service (or the chip's ×) clears the filter. The coverage is the salon
// info's `serviceCoverage` (the one source the wizard uses too), fetched on the first sign of intent on a tile. Without script the tiles
// are plain rows and every master shows.
import { loadSalonInfo } from "./salon-info";

export function initFilter(): void {
  const panel = document.querySelector<HTMLElement>("[data-svc-filter]");
  const row = document.querySelector<HTMLElement>("[data-filter-chip]");
  const root = document.querySelector<HTMLElement>("[data-book-root]");
  if (!panel || !row || !root) return;
  const api = root.dataset.api ?? "";
  const slug = root.dataset.slug ?? "";
  const tiles = [...panel.querySelectorAll<HTMLElement>("[data-filter-id]")];
  const cards = [...document.querySelectorAll<HTMLElement>("[data-mgrid] .mcard")];
  const label = row.querySelector<HTMLElement>("[data-filter-label]")!;
  const empty = document.querySelector<HTMLElement>("[data-filter-empty]")!;
  const rest = document.getElementById("mrest");
  const more = document.getElementById("showall");
  const template = row.dataset.template ?? "{name}";
  let active: string | null = null;
  /** serviceId -> master ids, from the salon info; null until it has loaded. */
  let coverage: Map<string, Set<string>> | null = null;

  const warm = async (): Promise<boolean> => {
    if (coverage) return true;
    const info = await loadSalonInfo(api, slug);
    if (!info) return false;
    coverage = new Map(info.serviceCoverage.map((c) => [c.serviceId, new Set(c.masters.map((m) => m.masterId))]));
    return true;
  };

  function apply(): void {
    const tile = tiles.find((t) => t.dataset.filterId === active);
    const who = active ? coverage?.get(active) : undefined;
    let visible = 0;
    for (const c of cards) {
      const show = !active || !!who?.has(c.dataset.masterId ?? "");
      c.hidden = !show;
      if (show) visible++;
    }
    for (const t of tiles) t.setAttribute("aria-pressed", String(t === tile));
    row!.hidden = !active;
    // `replace` with a function: a service name containing «$&» is never read as a replacement pattern.
    label.textContent = tile ? template.replace("{name}", () => tile.querySelector(".name")?.textContent ?? "") : "";
    empty.hidden = !active || visible > 0;
    // A filtered set is shown whole; clearing the filter re-arms the «show all» cap (as the app does).
    if (rest) rest.hidden = !active;
    if (more) more.hidden = !!active;
  }
  async function toggle(tile: HTMLElement): Promise<void> {
    const id = tile.dataset.filterId!;
    if (active === id) {
      active = null;
      return apply();
    }
    if (!(await warm())) return; // the info could not be loaded: no filter (the next tap tries again)
    active = id;
    apply();
    document.querySelector<HTMLElement>('[data-tab="1"]')?.click(); // selecting jumps to «Майстри»
  }
  for (const t of tiles) {
    t.setAttribute("role", "button");
    t.tabIndex = 0;
    t.setAttribute("aria-pressed", "false");
    t.addEventListener("click", () => void toggle(t));
    t.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      void toggle(t);
    });
    for (const ev of ["pointerenter", "touchstart", "focus"]) t.addEventListener(ev, () => void warm(), { once: true, passive: true });
  }
  row.querySelector("[data-filter-clear]")!.addEventListener("click", () => {
    active = null;
    apply();
  });
}
