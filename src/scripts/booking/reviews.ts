// Review sorting and paging on the link pages: GET /api/v1/book/{slug}/reviews (master) or /book/s/{slug}/reviews (salon), 5 per page.
// The server renders the first view; this replaces it on a new sort and appends further pages. Cards are cloned from the server-rendered
// <template> (the same ReviewCard component), so their styling is the component's own.
import { relativeUk } from "../../lib/booking/format.ts";
import { parseReviewsPage, type ReviewItem } from "../../lib/booking/types.ts";

const PAGE = 5;

export function initReviews(): void {
  document.querySelectorAll<HTMLElement>("[data-reviews]").forEach(setup);
}

function setup(root: HTMLElement): void {
  const { api = "", slug = "", kind = "master" } = root.dataset;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s);
  const list = $("[data-review-list]");
  const more = $<HTMLButtonElement>("[data-more]");
  const status = $("[data-rev-status]");
  const label = $("[data-sort-label]");
  const menu = $<HTMLDetailsElement>("[data-sortmenu]");
  const tpl = $<HTMLTemplateElement>("[data-review-tpl]");
  if (!list || !more || !tpl) return;
  const moreBtn: HTMLButtonElement = more;
  let sort = root.dataset.sort ?? "NEWEST";
  let page = 0;
  let totalPages = Math.ceil(Number(root.dataset.count ?? 0) / PAGE);
  let busy = false;
  const ratingLabel = root.dataset.ratingLabel ?? "{rating}";

  const card = (r: ReviewItem): Node => {
    const n = (tpl.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
    const idx = (Array.from(r.clientDisplayName).reduce((a, c) => a + c.codePointAt(0)!, 0) % 6) + 1;
    const av = n.querySelector<HTMLElement>(".ravatar")!;
    av.className = `ravatar av-${idx}`;
    n.querySelector(".t-sub12")!.textContent = r.clientDisplayName;
    n.querySelector(".head .t-fb")!.textContent = relativeUk(r.createdAt);
    const stars = n.querySelector<HTMLElement>(".stars")!;
    stars.setAttribute("aria-label", ratingLabel.replace("{rating}", String(r.rating)));
    stars.querySelectorAll<HTMLElement>(":scope > span").forEach((s, i) => s.classList.toggle("on", i < r.rating));
    const body = n.querySelector<HTMLElement>(".body-text");
    if (r.comment) body!.textContent = r.comment;
    else body?.remove();
    const svc = n.querySelector<HTMLElement>(".svc");
    if (r.serviceName) svc!.querySelector(".t-fb")!.textContent = r.serviceName;
    else svc?.remove();
    return n;
  };

  const show = (text: string | null) => {
    if (!status) return;
    status.hidden = text === null;
    status.textContent = text ?? "";
  };
  const paintMore = () => {
    moreBtn.hidden = page + 1 >= totalPages;
    moreBtn.disabled = false;
  };

  async function load(nextSort: string, nextPage: number, replace: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    moreBtn.disabled = true;
    show(root.dataset.loading ?? "");
    try {
      const q = new URLSearchParams({ sort: nextSort, page: String(nextPage), size: String(PAGE) });
      const res = await fetch(`${api}/api/v1/book/${kind === "salon" ? "s/" : ""}${slug}/reviews?${q}`, { headers: { Accept: "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(15000) });
      const data = res.ok ? parseReviewsPage(await res.json()) : null;
      if (!data) throw new Error("reviews");
      if (replace) list!.replaceChildren();
      data.items.forEach((r) => list!.append(card(r)));
      sort = nextSort;
      page = data.page;
      totalPages = data.totalPages;
      show(null);
    } catch {
      show(root.dataset.error ?? "");
    } finally {
      busy = false;
      paintMore();
    }
  }

  // The sort popover: Escape and a click outside close it; near the bottom (under the sticky shelf) it opens upwards.
  const close = () => menu?.removeAttribute("open");
  menu?.addEventListener("toggle", () => {
    const panel = menu.querySelector<HTMLElement>(".menu");
    if (!menu.open || !panel) return;
    panel.classList.remove("up");
    const shelf = document.querySelector<HTMLElement>(".shelf");
    const limit = shelf ? shelf.getBoundingClientRect().top : window.innerHeight;
    if (panel.getBoundingClientRect().bottom > limit) panel.classList.add("up");
  });
  document.addEventListener("click", (e) => menu?.open && !menu.contains(e.target as Node) && close());
  menu?.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !menu.open) return;
    close();
    menu.querySelector<HTMLElement>("summary")?.focus();
  });
  more.addEventListener("click", () => void load(sort, page + 1, false));
  root.querySelectorAll<HTMLAnchorElement>("[data-sort-option]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const next = a.dataset.sortOption!;
      root.querySelectorAll("[data-sort-option]").forEach((o) => (o === a ? o.setAttribute("aria-current", "true") : o.removeAttribute("aria-current")));
      if (label) label.textContent = a.textContent;
      menu?.removeAttribute("open");
      void load(next, 0, true);
    }),
  );
  more.hidden = page + 1 >= totalPages;
}
