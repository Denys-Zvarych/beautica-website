// The salon wizard (phase 016), loaded by the booking island only on /book/s/{slug}. It ports the app's client salon flow:
// services -> masters (assign every service to ONE master, no "any master") -> date + time once per chosen master -> contact/OTP once
// -> confirm (one card per master, own comment, no grand total) -> one booking per master, sequentially, with the same guest token.
// The island (app.ts) keeps the generic steps; this module owns the assignment, the per-master schedule and the per-master submit.
import { formatDuration, formatRating, pluralRecords } from "../../lib/booking/format";
import { categoryIconFor } from "../../lib/categoryIcon";
import type { SalonInfo } from "../../lib/booking/types";
import { hydrateIcons } from "./icons";
import { cleanComment } from "../../lib/booking/text.ts";
import { done as doneIcon, errorOutline, person } from "../../lib/icons/materialPaths";
import { cancelPath, cancelToken, createBooking, type BookingCreated, type Fail, type Slot, type TelegramAvailability } from "./api";
import { clearMarker, createLedger, mayExist, readMarker, saveMarker } from "./uncertain";
import { track } from "../track";
import { showBookingUrl } from "./booking-url";
import { firstWithToken, mountReminders } from "./reminder-channel";

export interface Svc {
  id: string;
  name: string;
  minutes: number;
  /** Floor price (master link: `priceFrom`; salon: `priceMin`). */
  price: number;
  /** Salon-wide price text of the catalogue («600 - 900 ₴»), shown instead of «від N ₴» in salon mode. */
  label?: string;
}
/** One appointment-to-be: a master and the services assigned to them (catalogue order). */
export interface Group {
  masterId: string;
  name: string;
  services: Svc[];
}
export interface RecapView {
  services: Svc[];
  day: string;
  slot: Slot;
  /** Salon + address rows on top (master link). The salon cards carry them once, above all cards. */
  head: boolean;
}
type Strings = Record<string, string>;
export interface Core {
  root: HTMLElement;
  S: Strings;
  api: string;
  slug: string;
  policy: string;
  services: Svc[];
  /** Mutable island state (shared object): the live day/slot belong to the master whose page is open. */
  st: { step: string; picked: Set<string>; day: string | null; slot: Slot | null; month: number; expanded: boolean; guestToken: string | null; busy: boolean; done: boolean; partial: boolean };
  $: <T extends HTMLElement = HTMLElement>(sel: string, root?: ParentNode) => T;
  $$: <T extends HTMLElement = HTMLElement>(sel: string, root?: ParentNode) => T[];
  el: <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => HTMLElementTagNameMap[K];
  icon: (path: string, stroke?: boolean) => string;
  fmt: (s: string, vars: Record<string, string | number>) => string;
  go: (step: string, push?: boolean) => void;
  show: (step: string) => void;
  busy: (btn: HTMLButtonElement, on: boolean) => void;
  lrow: (label: string, value: string, detail?: string) => string;
  recap: (into: HTMLElement, view: RecapView) => void;
  /** Resolves once the lazy calendar chooser module is loaded (never rejects); `calendarButton` is synchronous after it. */
  calendarReady: () => Promise<unknown>;
  calendarButton: (b: { startsAt: string; minutes: number; master: string; services: string; cancelPath?: string | null }) => HTMLElement;
  /** The guest token was refused (401): back to the code step with the session banner. */
  sessionExpired: () => void;
  /** Re-open the time step for the current master with the «already taken» notice. */
  conflict: () => void;
  /** Once a booking exists (or may exist) the guest's name and phone are frozen: the rest is booked under the same identity. */
  lockContact: () => void;
  /** «вівторок, 27 жовтня, 10:30» (the notice after a reload). */
  whenLabel: (day: string, slot: Slot) => string;
  /** Forget the cached free times (after any booking attempt). */
  invalidateSlots: () => void;
  name: () => string;
  surname: () => string;
  salonName: string;
  city: string;
  address: string;
  note: string;
}
interface MasterRef {
  id: string;
  name: string;
  title: string | null;
  avatarUrl: string | null;
  rating: number | null;
  reviews: number;
}
interface SalonData {
  masters: MasterRef[];
  /** serviceId -> masterId -> that master's assignment id (`masterServiceId`). */
  coverage: Record<string, Record<string, string>>;
}

/** The wizard's catalogue: the salon's categories and services, cloned from the fragment's templates (the page itself carries none of it). */
export function buildCatalogue(root: HTMLElement, info: SalonInfo): void {
  const list = root.querySelector<HTMLElement>("#svc-list")!;
  const cat = (root.querySelector<HTMLTemplateElement>("#tpl-cat")!).content.firstElementChild as HTMLElement;
  const svc = (root.querySelector<HTMLTemplateElement>("#tpl-svc")!).content.firstElementChild as HTMLElement;
  list.replaceChildren();
  info.serviceCategories.forEach((g, i) => {
    const group = cat.cloneNode(true) as HTMLDetailsElement;
    group.open = i === 0; // the first category starts open, as the app
    group.querySelector("noscript")?.remove();
    group.querySelector<HTMLElement>(".lbl")!.textContent = g.displayName;
    group.querySelector<HTMLElement>(".badge:not(.sel) .t-fb")!.textContent = String(g.services.length);
    group.querySelector<HTMLElement>(".ai")!.dataset.src = categoryIconFor(g.displayName, g.category);
    const body = group.querySelector<HTMLElement>(".acc-body")!;
    for (const sv of g.services) {
      const tile = svc.cloneNode(true) as HTMLElement;
      tile.dataset.id = sv.id;
      tile.dataset.name = sv.name;
      tile.dataset.min = String(sv.durationMinutes);
      tile.dataset.price = String(sv.priceMin);
      tile.dataset.label = sv.priceLabel;
      tile.querySelector<HTMLElement>(".name")!.textContent = sv.name;
      tile.querySelector<HTMLElement>(".deep")!.textContent = sv.priceLabel;
      tile.querySelector<HTMLElement>(".dur")!.append(formatDuration(sv.durationMinutes));
      body.append(tile);
    }
    list.append(group);
  });
  hydrateIcons(list);
}
interface Sched {
  sig: string;
  day: string | null;
  slot: Slot | null;
  month: number;
}
type Outcome = { ok: true; data: BookingCreated } | { ok: false; fail: Fail };

export function createSalon(core: Core, info: SalonInfo) {
  const { S, st, $, $$, el, icon, fmt } = core;
  const data: SalonData = {
    masters: info.masters.map((m) => ({ id: m.masterId, name: m.name, title: m.professionalTitle, avatarUrl: m.avatarUrl, rating: m.avgRating, reviews: m.reviewCount })),
    coverage: Object.fromEntries(info.serviceCoverage.map((c) => [c.serviceId, Object.fromEntries(c.masters.map((m) => [m.masterId, m.masterServiceId]))])),
  };
  /** A master's strip (the app's MasterStrip): the fragment's template, filled in. */
  const tplStrip = $<HTMLTemplateElement>("#tpl-strip").content.firstElementChild as HTMLElement;
  function stripFor(id: string): HTMLElement | null {
    const m = data.masters.find((x) => x.id === id);
    if (!m) return null;
    const e = tplStrip.cloneNode(true) as HTMLElement;
    e.querySelector<HTMLElement>(".txt .t-sub13")!.textContent = m.name;
    if (m.title) e.querySelector<HTMLElement>(".sub > :first-child")!.textContent = m.title;
    const rate = e.querySelector<HTMLElement>(".rate")!;
    rate.querySelector<HTMLElement>(".t-strong11")!.textContent = formatRating(m.reviews > 0 ? m.rating : null);
    if (m.reviews > 0) rate.append(el("span", "t-fb muted", `(${m.reviews})`));
    if (m.avatarUrl) {
      const img = el("img");
      img.src = m.avatarUrl;
      img.alt = "";
      img.width = img.height = 52;
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      e.querySelector<HTMLElement>(".disc")!.replaceChildren(img);
    }
    return e;
  }
  const covers = (mid: string, sid: string): boolean => !!data.coverage[sid]?.[mid];

  const pm = new Set<string>(); // picked masters
  const choice = new Map<string, string>(); // serviceId -> master chosen by the guest (several candidates)
  const sched = new Map<string, Sched>(); // per master: the chosen day / time
  const comments = new Map<string, string>(); // per master: the note (<= 500)
  const results = new Map<string, Outcome>();
  /** A POST whose outcome is unknown (dropped connection, unreadable answer): the booking MAY exist. Its slot is frozen: the only legal
   *  move is to send the SAME slot again, never another time (that could book the guest twice). */
  const uncertain = createLedger();
  let plan: Group[] = [];
  let mi = 0;
  let lastFocus = "";

  const picked = (): Svc[] => core.services.filter((s) => st.picked.has(s.id));
  const eligible = (): MasterRef[] => data.masters.filter((m) => picked().some((s) => covers(m.id, s.id)));
  /** The picked masters who can perform the service. */
  const candidates = (sid: string): string[] => eligible().filter((m) => pm.has(m.id) && covers(m.id, sid)).map((m) => m.id);
  /** The master who will perform the service, or null while unresolved (app: `effective`). */
  function effective(sid: string): string | null {
    const c = candidates(sid);
    if (!c.length) return null;
    const chosen = choice.get(sid);
    if (chosen && c.includes(chosen)) return chosen;
    return c.length === 1 ? c[0]! : null;
  }
  const idsOf = (g: Group): string[] => g.services.map((s) => data.coverage[s.id]![g.masterId]!);
  const sigOf = (g: Group): string => idsOf(g).join(",");
  const avatarClass = (i: number): string => `av-${(i % 6) + 1}`;

  // ------------------------------------------------------------------ masters step
  function renderMasters(): void {
    const pickedNow = picked();
    for (const sid of [...choice.keys()]) if (!st.picked.has(sid)) choice.delete(sid);
    const elig = eligible();
    for (const id of [...pm]) if (!elig.some((m) => m.id === id)) pm.delete(id);
    const list = $("#master-list");
    list.replaceChildren();
    for (const m of elig) {
      const row = el("label", "mrow");
      const input = el("input");
      input.type = "checkbox";
      input.checked = pm.has(m.id);
      input.dataset.master = m.id;
      const covered = pickedNow.filter((s) => covers(m.id, s.id)).map((s) => s.name).join(" · ");
      input.setAttribute("aria-label", fmt(S.mastersToggle ?? "", { name: m.name, covered }));
      input.addEventListener("change", () => {
        if (input.checked) pm.add(m.id);
        else pm.delete(m.id);
        renderPlan();
      });
      const chk = el("span", "chk");
      chk.setAttribute("aria-hidden", "true");
      chk.innerHTML = icon(doneIcon);
      const strip = stripFor(m.id);
      const cov = el("div", "cov");
      cov.innerHTML = icon(checkOutline);
      cov.append(el("span", "t-fb", covered));
      row.append(input, ...(strip ? [strip] : []), chk, cov);
      list.append(row);
    }
    renderPlan();
  }
  const checkOutline = "M16.59 7.58 10 14.17l-3.59-3.58L5 12l5 5 8-8zM12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z";

  function renderPlan(): void {
    const box = $("#plan");
    box.replaceChildren();
    const pickedNow = picked();
    const groups = eligible().filter((m) => pm.has(m.id)).map((m, i) => ({ m, i, services: pickedNow.filter((s) => effective(s.id) === m.id) })).filter((g) => g.services.length);
    const choices = pickedNow.filter((s) => candidates(s.id).length > 1);
    const uncovered = pickedNow.filter((s) => !candidates(s.id).length);
    const assigned = pickedNow.filter((s) => effective(s.id)).length;
    const all = pickedNow.length > 0 && assigned === pickedNow.length;
    $("#plan-count").textContent = groups.length ? pluralRecords(groups.length) : "";
    if (!pm.size) {
      const w = el("div", "pwell empty");
      w.append(el("span", "t-fb", S.groupingEmpty ?? ""));
      box.append(w);
    } else {
      if (choices.length) {
        box.append(el("p", "t-section", S.resolverHint));
        box.append(el("div", "g-sm"));
        for (const s of choices) {
          const sel = effective(s.id);
          const w = el("div", "pwell");
          const top = el("div", `top ${sel ? "ok" : "open"}`);
          top.innerHTML = icon(sel ? checkOutline : errorOutline);
          top.append(el("span", "t-strong ellipsis", s.name));
          if (!sel) top.append(el("span", "t-fb muted", S.chooseMaster));
          const chips = el("div", "mchips");
          for (const mid of candidates(s.id)) {
            const m = data.masters.find((x) => x.id === mid)!;
            const chip = el("button", "mchip");
            chip.type = "button";
            chip.dataset.chip = `${s.id}|${mid}`;
            chip.setAttribute("aria-pressed", String(sel === mid));
            const av = el("span", `av ${avatarClass(eligible().findIndex((x) => x.id === mid))}`);
            av.innerHTML = icon(sel === mid ? doneIcon : person);
            chip.append(av, el("span", "", m.name));
            chip.addEventListener("click", () => {
              choice.set(s.id, mid);
              lastFocus = chip.dataset.chip!;
              renderPlan();
            });
            chips.append(chip);
          }
          w.append(top, chips);
          box.append(w, el("div", "plan-gap"));
        }
      }
      for (const g of groups) {
        const row = el("div", "pgroup");
        const av = el("span", `ravatar ${avatarClass(g.i)}`);
        av.innerHTML = icon(person);
        const grow = el("div", "grow");
        grow.append(el("div", "t-name-13w800 ellipsis", g.m.name), el("div", "t-fb sec", g.services.map((s) => s.name).join(", ")));
        row.append(av, grow);
        box.append(row);
      }
      for (const s of uncovered) {
        const row = el("div", "puncov");
        row.innerHTML = icon(errorOutline);
        row.append(el("span", "t-fb", fmt(S.uncovered ?? "", { service: s.name })));
        box.append(row);
      }
    }
    $("#plan-hint").textContent = (all ? S.allAssigned : S.partialAssigned) ?? "";
    $("#masters-progress").textContent = fmt(S.progress ?? "", { assigned, total: pickedNow.length });
    $<HTMLButtonElement>("#cta-masters").disabled = !all;
    if (lastFocus) $<HTMLElement>(`[data-chip="${CSS.escape(lastFocus)}"]`, box)?.focus();
    lastFocus = "";
  }

  /** «Далі» on the masters step: freezes the assignment into one group per master and starts at the first master's date. */
  function commit(): boolean {
    const pickedNow = picked();
    if (!pickedNow.length || pickedNow.some((s) => !effective(s.id))) return false;
    plan = eligible()
      .filter((m) => pm.has(m.id))
      .map((m) => ({ masterId: m.id, name: m.name, services: pickedNow.filter((s) => effective(s.id) === m.id) }))
      .filter((g) => g.services.length);
    // A master whose service set did not change keeps the day and time already chosen; anything else starts clean.
    for (const [id, v] of [...sched]) if (!plan.some((g) => g.masterId === id && sigOf(g) === v.sig)) sched.delete(id);
    for (const id of [...comments.keys()]) if (!plan.some((g) => g.masterId === id)) comments.delete(id);
    mi = 0;
    load(0);
    return true;
  }

  // ------------------------------------------------------------------ per-master schedule (date + time)
  function save(): void {
    const g = plan[mi];
    if (g) sched.set(g.masterId, { sig: sigOf(g), day: st.day, slot: st.slot, month: st.month });
  }
  function load(i: number): void {
    mi = i;
    const v = sched.get(plan[i]!.masterId);
    st.day = v?.day ?? null;
    st.slot = v?.slot ?? null;
    st.month = v?.month ?? 0;
    st.expanded = false;
  }
  function setMaster(i: number): void {
    if (i === mi || !plan[i]) return;
    save();
    load(i);
  }
  const strips = (): void => {
    const g = plan[mi];
    if (!g) return;
    for (const host of $$("[data-strip]", core.root)) host.replaceChildren(...[stripFor(g.masterId)].filter((x): x is HTMLElement => !!x));
    const many = plan.length > 1 && !st.partial;
    for (const p of $$("[data-mpager]", core.root)) {
      p.hidden = !many;
      $("[data-mcount]", p).textContent = fmt(S.pagerCounter ?? "", { current: mi + 1, count: plan.length });
      $<HTMLButtonElement>("[data-mprev]", p).disabled = mi === 0;
      $<HTMLButtonElement>("[data-mnext]", p).disabled = mi === plan.length - 1;
    }
  };
  /** Pager arrows: another master's page, on the time step when that master already has a time, else on the date step. */
  function pageTo(i: number): void {
    if (i < 0 || i >= plan.length || i === mi) return;
    setMaster(i);
    core.go(st.slot ? "time" : "date");
  }
  for (const p of $$("[data-mpager]", core.root)) {
    $("[data-mprev]", p).addEventListener("click", () => pageTo(mi - 1));
    $("[data-mnext]", p).addEventListener("click", () => pageTo(mi + 1));
  }
  const lastMaster = (): boolean => st.partial || mi >= plan.length - 1;
  function ctaLabel(): void {
    const lbl = $("#cta-time .lbl");
    if (lbl) lbl.textContent = (lastMaster() ? S.timeCta : S.next) ?? "";
  }
  /** «Далі» / «Підтвердити» on the time step: the next master's date, or (the last one) the contact step. */
  function afterTime(): void {
    save();
    if (st.partial) return core.go("confirm");
    if (mi < plan.length - 1) {
      load(mi + 1);
      return core.go(st.slot ? "time" : "date");
    }
    core.go(st.guestToken ? "confirm" : "contact");
  }

  // ------------------------------------------------------------------ confirm: one card per master
  const slotOf = (g: Group): Slot | null => uncertain.get(g.masterId)?.slot ?? (g.masterId === plan[mi]?.masterId ? st.slot : sched.get(g.masterId)?.slot) ?? null;
  const dayOf = (g: Group): string | null => uncertain.get(g.masterId)?.day ?? (g.masterId === plan[mi]?.masterId ? st.day : sched.get(g.masterId)?.day) ?? null;
  const card = (id: string): HTMLElement | null => core.root.querySelector<HTMLElement>(`[data-appt="${CSS.escape(id)}"]`);
  const cardError = (a: HTMLElement, msg: string | null): void => {
    a.querySelector<HTMLElement>("[data-appt-error]")!.hidden = !msg;
    if (msg) a.querySelector<HTMLElement>("[data-appt-error-text]")!.textContent = msg;
  };

  function renderConfirm(): void {
    save();
    $("#salon-addr").innerHTML = core.lrow(S.salonLabel!, core.salonName) + `<div class="rule"></div>` + core.lrow(S.addressLabel!, [core.city, core.address].filter(Boolean).join(", "), core.note);
    const host = $("#salon-cards");
    host.replaceChildren();
    const tpl = $<HTMLTemplateElement>("#tpl-appt").content.firstElementChild as HTMLElement;
    plan.forEach((g) => {
      const a = tpl.cloneNode(true) as HTMLElement;
      a.dataset.appt = g.masterId;
      const strip = stripFor(g.masterId);
      if (strip) a.querySelector("[data-strip]")!.replaceChildren(strip);
      const day = dayOf(g);
      const slot = slotOf(g);
      if (day && slot) core.recap(a.querySelector<HTMLElement>("[data-appt-body]")!, { services: g.services, day, slot, head: false });
      const text = a.querySelector<HTMLTextAreaElement>("[data-appt-text]")!;
      const label = a.querySelector<HTMLLabelElement>("[data-appt-label]")!;
      text.id = `note-${g.masterId}`;
      label.htmlFor = text.id;
      text.value = comments.get(g.masterId) ?? "";
      text.addEventListener("input", () => {
        const clean = text.value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
        if (clean !== text.value) text.value = clean;
        comments.set(g.masterId, text.value);
      });
      const r = results.get(g.masterId);
      if (r?.ok) {
        text.readOnly = true;
        a.querySelector<HTMLElement>("[data-appt-ok]")!.hidden = false;
      }
      if (uncertain.has(g.masterId)) {
        text.readOnly = true; // the request that may exist carried this note
        cardError(a, fmt(S.uncertain!, { master: g.name }));
      }
      a.querySelector<HTMLButtonElement>("[data-appt-change]")!.addEventListener("click", () => {
        setMaster(plan.indexOf(g));
        st.slot = null;
        save();
        core.conflict();
      });
      host.append(a);
    });
    $("#cta-confirm .lbl").textContent = (st.partial ? S.retry : S.cta) ?? "";
    $("#submit-error").hidden = true;
  }

  const failText = (fail: Fail): string => (fail === "provider-unavailable" ? S.blockedSalon! : fail === "conflict" ? S.conflict! : fail === "validation" ? S.invalid! : fail === "rate-limited" ? S.limit! : fail === "unavailable" ? fmt(S.unavailable!, { email: S.supportEmail! }) : S.error!);

  /** One POST per master, in order, with the same guest token. Stops at the first failure; masters already booked stay booked. */
  async function submit(btn: HTMLButtonElement): Promise<void> {
    if (st.busy) return;
    if (!st.guestToken) return core.sessionExpired(); // cleared on page hide / after a final failure: verify the phone again
    $("#submit-error").hidden = true;
    core.busy(btn, true);
    $("#cta-confirm .lbl").textContent = S.sending ?? "";
    void core.calendarReady();
    let stopped = false;
    for (const g of plan) {
      if (results.get(g.masterId)?.ok) continue;
      const a = card(g.masterId)!;
      cardError(a, null);
      a.querySelector<HTMLElement>("[data-appt-change]")!.hidden = true;
      const slot = slotOf(g); // an uncertain master always re-sends its frozen slot
      if (!slot || !st.guestToken) {
        stopped = true;
        break;
      }
      const prior = uncertain.has(g.masterId);
      const r = await createBooking(core.api, core.slug, st.guestToken, { serviceIds: idsOf(g), startsAt: slot.startsAt, name: core.name(), surname: core.surname(), policyVersion: core.policy, clientComment: cleanComment(comments.get(g.masterId) ?? "") }, g.masterId);
      core.invalidateSlots();
      if (r.ok) {
        uncertain.delete(g.masterId);
        const mk = readMarker("salon", core.slug);
        if (!mk || mk.masterId === g.masterId) clearMarker("salon", core.slug);
        results.set(g.masterId, r);
        st.partial = true;
        core.lockContact();
        track("booking_confirmed", { services_count: g.services.length });
        a.querySelector<HTMLTextAreaElement>("[data-appt-text]")!.readOnly = true;
        a.querySelector<HTMLElement>("[data-appt-ok]")!.hidden = false;
        continue;
      }
      track("booking_error", { code: r.fail === "conflict" ? 409 : r.fail === "rate-limited" ? 429 : r.fail === "unavailable" ? 503 : r.fail === "provider-unavailable" ? "blocked" : "other" });
      stopped = true;
      if (r.fail === "unauthorized") {
        st.guestToken = null;
        core.busy(btn, false);
        return core.sessionExpired();
      }
      // A dropped connection or an unreadable answer may still have created the booking; so may an earlier such attempt that this one
      // now meets with a 409 («probably booked by you»). Never offer another time for that master.
      if (mayExist(r, prior)) {
        if (!prior) {
          uncertain.set(g.masterId, { slot, day: dayOf(g) ?? "" });
          // Survives a reload (no personal data): master id, slot start, a label of the time and the master.
          saveMarker("salon", core.slug, { masterId: g.masterId, slotStartIso: slot.startsAt, label: `${core.whenLabel(dayOf(g) ?? "", slot)}, ${g.name}` });
        }
        st.partial = true; // freezes the way back (only confirm, time and date stay reachable) and the contact fields
        core.lockContact();
        cardError(a, fmt(S.uncertain!, { master: g.name }));
      } else {
        cardError(a, r.fail === "provider-unavailable" ? failText(r.fail) : `${fmt(S.failedFor!, { master: g.name })} ${failText(r.fail)}`);
        if (r.fail === "conflict") a.querySelector<HTMLElement>("[data-appt-change]")!.hidden = false;
        // A rejected request will not succeed by repeating it: drop the token, the next try verifies the phone again.
        if (r.fail === "validation" || r.fail === "not-found") st.guestToken = null;
      }
      a.scrollIntoView({ block: "center" });
      break;
    }
    core.busy(btn, false);
    $("#cta-confirm .lbl").textContent = (st.partial ? S.retry : S.cta) ?? "";
    if (stopped) return;
    st.done = true;
    st.guestToken = null;
    await core.calendarReady();
    renderDone();
    history.replaceState({ bk: "done" }, "", location.href);
    // Phase 032: one booking = one cancel page = the done screen's own URL. Several masters have several pages, so the address stays.
    const only = plan.length === 1 ? results.get(plan[0]!.masterId) : undefined;
    if (only?.ok) showBookingUrl(cancelPath(only.data.cancelUrl));
    core.show("done");
  }

  // ------------------------------------------------------------------ done: each booking with its own cancel link and .ics
  function renderDone(): void {
    const host = $("#done-list");
    host.replaceChildren();
    const offers: { token: string | null; telegram: TelegramAvailability | null }[] = [];
    const tpl = $<HTMLTemplateElement>("#tpl-done").content.firstElementChild as HTMLElement;
    const first = tpl.cloneNode(true) as HTMLElement;
    first.querySelector("[data-done-title]")!.remove();
    first.querySelector<HTMLElement>("[data-done-body]")!.innerHTML = core.lrow(S.salonLabel!, core.salonName) + core.lrow(S.addressLabel!, [core.city, core.address].filter(Boolean).join(", "), core.note);
    host.append(first);
    for (const g of plan) {
      const r = results.get(g.masterId);
      const day = dayOf(g);
      const slot = slotOf(g);
      if (!r?.ok || !day || !slot) continue;
      const a = tpl.cloneNode(true) as HTMLElement;
      a.querySelector("[data-done-title]")!.textContent = fmt(S.doneOne ?? "", { master: g.name });
      const body = a.querySelector<HTMLElement>("[data-done-body]")!;
      core.recap(body, { services: g.services, day, slot, head: false });
      // The cancel link is a bearer token (it arrives by SMS): it goes into the calendar event only (phase 030), never analytics or logs.
      const path = cancelPath(r.data.cancelUrl);
      const minutes = g.services.reduce((n, s) => n + s.minutes, 0) || r.data.durationMinutes;
      body.append(el("div", "rule"), core.calendarButton({ startsAt: r.data.startsAt, minutes, master: g.name, services: g.services.map((s) => s.name).join(", "), cancelPath: path }));
      host.append(a);
      offers.push({ token: cancelToken(path), telegram: r.data.telegram });
    }
    // Telegram is per phone: the first booking WITH a cancel token stands for the whole visit.
    const offer = firstWithToken(offers);
    if (offer) mountReminders({ root: document.getElementById("done-reminders"), api: core.api, token: offer.token, telegram: offer.telegram, navigate: (u) => location.assign(u), track });
  }

  return {
    renderMasters,
    commit,
    services: (): Svc[] => plan[mi]?.services ?? [],
    masterId: (): string | undefined => plan[mi]?.masterId,
    apiIds: (): string[] => (plan[mi] ? idsOf(plan[mi]!) : []),
    /** The master after the open one (for prefetching its free days), or null. */
    next: (): { masterId: string; ids: string[]; month: number } | null => {
      const g = plan[mi + 1];
      return g ? { masterId: g.masterId, ids: idsOf(g), month: sched.get(g.masterId)?.month ?? 0 } : null;
    },
    index: (): number => mi,
    setMaster,
    strips,
    ctaLabel,
    afterTime,
    renderConfirm,
    submit,
  };
}
export type SalonFlow = ReturnType<typeof createSalon>;
