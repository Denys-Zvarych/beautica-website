// Progressive tabs of the master page. Without script the three tabs are anchor links to the three sections, all of which are in the
// page. With script they become ARIA tabs and show one panel at a time. The tab bar itself is server-rendered, so nothing shifts.
export function initTabs(): void {
  const bar = document.querySelector<HTMLElement>("[data-tabs]");
  const panels = [...document.querySelectorAll<HTMLElement>("[data-panel]")];
  const tabs = [...document.querySelectorAll<HTMLAnchorElement>("[data-tab]")];
  if (!bar || panels.length === 0) return;
  bar.setAttribute("role", "tablist");
  const select = (i: number, animate: boolean) => {
    tabs.forEach((t, k) => {
      t.setAttribute("aria-selected", String(k === i));
      t.tabIndex = k === i ? 0 : -1; // roving tabindex: one tab stop, arrows move between tabs (WAI-ARIA tabs pattern)
      t.setAttribute("aria-controls", `panel-${k}`);
      t.removeAttribute("aria-current");
    });
    panels.forEach((p, k) => {
      p.hidden = k !== i;
      p.classList.toggle("swap", animate && k === i);
    });
  };
  tabs.forEach((t, i) => {
    t.setAttribute("role", "tab");
    t.addEventListener("click", (e) => {
      e.preventDefault();
      select(i, true);
    });
    t.addEventListener("keydown", (e) => {
      const to = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
      if (to < 0) return;
      e.preventDefault();
      select(to, true);
      tabs[to]!.focus();
    });
  });
  panels.forEach((p) => p.setAttribute("role", "tabpanel"));
  // Other in-page links to a panel (the salon's «Записатись на послугу» opens the masters tab).
  document.querySelectorAll<HTMLAnchorElement>('a[href^="#panel-"]:not([data-tab])').forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      select(Number(a.getAttribute("href")!.slice(7)), true);
      window.scrollTo({ top: 0 });
    }),
  );
  select(0, false);
}

/** Salon page: masters beyond the first six start collapsed behind a "show all" button (all are in the HTML without script). */
export function initShowAll(): void {
  const btn = document.getElementById("showall");
  const rest = document.getElementById("mrest");
  if (!btn || !rest) return;
  rest.hidden = true;
  btn.hidden = false;
  btn.addEventListener("click", () => {
    rest.hidden = false;
    btn.hidden = true;
  });
}
