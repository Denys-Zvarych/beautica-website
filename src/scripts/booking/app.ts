// The guest booking island (phase 009). Vanilla TS, no router: one screen visible at a time, the step kept in history.state so
// the back button works, the URL never changes. Secrets live in memory only: the guest token, the name and the phone are never
// written to storage, URLs, logs or analytics.
import { formatDuration, formatPriceFrom, pluralServices } from "../../lib/booking/format";
import { formatPhoneGrouped, nationalDigits } from "../../lib/phone";
import { WINDOW_DAYS, addDays, dayLong, dayShort, daysBetween, inWindow, kyivDay, kyivTime, kyivToday, maxMonthOffset, monthLabel, monthView, partOfDay, weekdayMon0, weekdayShort, type Part } from "./calendar";
import { currentEnv, detectOtpSmsFormat, isInAppBrowser } from "./otp-format";
import { cancelPath, cancelToken, createBooking, getAvailability, getBookableDays, sendOtp, verifyOtp, type Fail, type Result, type Slot, type TelegramAvailability } from "./api";
import { mountTurnstile, type Widget } from "./turnstile";
import { closeRounded, errorOutline, eventAvailable, expandMoreRounded, schedule } from "../../lib/icons/materialPaths";
import { track } from "../track";
import { mountReminders } from "./reminder-channel";
import { hydrateIcons } from "./icons";
import { cleanComment, cleanName, typingName } from "../../lib/booking/text.ts";
import type { Core, RecapView, SalonFlow, Svc } from "./salon";
import { clearMarker, createLedger, mayExist, saveMarker } from "./uncertain";
import type { SalonInfo } from "../../lib/booking/types";
import { el, lrow } from "./recap-row";
import { brandMarks } from "../../lib/icons/brandMarks";
import { calendarLinks, calendarOrder, isIosInApp } from "./calendar-links";
import "../../styles/book-flow.css"; // step styles ship with the island: the profile pages do not carry them

type Step = "profile" | "services" | "masters" | "date" | "time" | "contact" | "otp" | "confirm" | "done";
type Strings = Record<string, string>;

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector<T>(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(sel)];
const fmt = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

function icon(path: string, stroke = false): string {
  return `<svg class="mi${stroke ? " stroke" : ""}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"></path></svg>`;
}
/**
 * Adopts the steps, then wires them. Master link: the server-rendered steps sit in a <template> (no DOM until the visitor opens the flow).
 * Salon link: the page carries none of it; the steps are the static fragment /book-steps/salon and the catalogue / masters come from the
 * salon info, both fetched here (in parallel with the wizard module). Rejects when they cannot be loaded.
 */
export async function initBooking(root: HTMLElement): Promise<{ open(): void }> {
  const api = root.dataset.api ?? "";
  const slug = root.dataset.slug ?? "";
  const salonMode = root.dataset.mode === "salon";
  let salonInfo: SalonInfo | null = null;
  let salonMod: typeof import("./salon") | null = null;
  if (salonMode) {
    const si = await import("./salon-info");
    const [html, info, mod] = await Promise.all([si.loadSteps(), si.loadSalonInfo(api, slug), import("./salon")]);
    if (!html || !info) throw new Error("salon wizard: steps or info unavailable");
    const tmp = document.createElement("template");
    tmp.innerHTML = html; // our own static asset (same origin), never user data
    root.append(tmp.content);
    salonInfo = info;
    salonMod = mod;
    mod.buildCatalogue(root, info);
    hydrateIcons(root);
  } else {
    const tpl = document.getElementById("book-steps") as HTMLTemplateElement | null;
    if (tpl) {
      root.append(tpl.content);
      tpl.remove();
      hydrateIcons(root);
    }
  }
  const siteKey = root.dataset.siteKey ?? "";
  const policy = root.dataset.policy ?? "";
  const salonName = root.dataset.salon ?? "";
  const city = root.dataset.city ?? "";
  const masterName = root.dataset.master ?? "";
  const address = root.dataset.address ?? "";
  const note = root.dataset.note ?? "";
  const S: Strings = JSON.parse($("#book-i18n").textContent ?? "{}");
  const services: Svc[] = $$("#svc-list [data-id]").map((b) => ({ id: b.dataset.id!, name: b.dataset.name!, minutes: Number(b.dataset.min), price: Number(b.dataset.price), ...(salonMode ? { label: b.dataset.label } : {}) }));
  const today = kyivToday();
  const maxOffset = maxMonthOffset(today);

  const st = {
    step: "profile" as Step,
    picked: new Set<string>(),
    expanded: false,
    month: 0,
    day: null as string | null,
    slot: null as Slot | null,
    slots: [] as Slot[],
    /** Bookable days per service selection (key = ordered ids): date -> working. Absent = unknown = enabled (fallback on any failure). */
    workDays: new Map<string, Map<string, boolean>>(),
    guestToken: null as string | null,
    phone: "", // +380XXXXXXXXX
    busy: false,
    done: false,
    /** Salon: at least one master is booked already (the rest can still be retried; the earlier ones are never repeated). */
    partial: false,
    /** Master link: a booking request of unknown outcome exists. Only the confirm step stays reachable and its slot is frozen (see uncertain.ts). */
    frozen: false,
  };
  const unsure = createLedger(); // master link: key ""
  let widget: Widget | null = null;
  let cooldown = 0;
  let cooldownTimer = 0;
  let otpRearm = 0; // pending WebOTP re-arm timer
  let otpAbort: AbortController | undefined; // WebOTP request of the current OTP step
  let conflictPending = false; // set when the booking answered 409: the time step re-opens with its message

  /** Salon mode (phase 016): the wizard module, loaded only on the salon link page. */
  let salon: SalonFlow | null = null;
  const picked = (): Svc[] => services.filter((s) => st.picked.has(s.id));
  /** The services of the page being filled in: the master's own (master link) or the services assigned to the current master (salon). */
  const chosen = (): Svc[] => (salon ? salon.services() : picked());
  const apiIds = (): string[] => (salon ? salon.apiIds() : chosen().map((s) => s.id));
  const totals = (list: Svc[] = chosen()) => ({ n: list.length, minutes: list.reduce((a, s) => a + s.minutes, 0), price: list.reduce((a, s) => a + s.price, 0) });
  const priceText = (s: Svc) => s.label || formatPriceFrom(s.price);
  const endIso = () => st.slot?.endsAt ?? "";
  const shortWindow = () => (st.day && st.slot ? `${dayShort(st.day)} · ${kyivTime(st.slot.startsAt)}–${kyivTime(endIso())}` : "");

  // ------------------------------------------------------------------ navigation
  const screens = $$("[data-screen]", root);
  function show(step: Step): void {
    st.step = step;
    if (step !== "otp") stopWebOtp();
    for (const s of screens) s.hidden = s.dataset.screen !== step;
    window.scrollTo(0, 0);
    const heading = $<HTMLElement>("[data-step-heading]", screens.find((s) => s.dataset.screen === step)!);
    // Moved to the step heading so a screen reader announces the new step (the heading has tabindex -1).
    if (step !== "profile" && heading) heading.focus({ preventScroll: true });
  }
  // The salon wizard repeats date / time once per master: the master index travels in the history state with the step.
  const mIndex = () => salon?.index() ?? 0;
  function go(step: Step, push = true): void {
    if (push && (history.state?.bk !== step || (history.state?.mi ?? 0) !== mIndex())) history.pushState({ bk: step, mi: mIndex() }, "", location.href);
    show(step);
    onEnter(step);
  }
  window.addEventListener("popstate", (e) => {
    if (st.done) return void go("done", false); // a finished booking never returns to a step that could submit again
    let step = (e.state?.bk as Step | undefined) ?? "profile";
    // Some masters are booked already: only their still-open time pages and the confirm step stay reachable (nothing is booked twice).
    if (st.partial && !["confirm", "date", "time"].includes(step)) step = "confirm";
    if (st.frozen) step = "confirm"; // a request of unknown outcome: no other time can be picked, nothing else to go back to
    if (salon && typeof e.state?.mi === "number") salon.setMaster(e.state.mi);
    show(step);
    onEnter(step);
  });
  // A reload keeps history.state but not the in-memory choices: always restart on the profile.
  if (history.state?.bk) history.replaceState(null, "", location.href);
  for (const b of $$("[data-back]", root)) b.addEventListener("click", () => (history.state?.bk ? history.back() : go("profile", false)));

  function onEnter(step: Step): void {
    if (step === "services") renderShelf("services");
    if (step === "masters") salon?.renderMasters();
    if (step === "date") {
      salon?.strips();
      renderCalendar();
      renderShelf("date");
      void loadWorkingDays();
      // Salon: the next master's days are fetched now, so their calendar is already grey where it should be when it opens.
      const nx = salon?.next();
      if (nx) void fetchDays(nx.masterId, nx.ids, nx.month);
    }
    if (step === "time") {
      salon?.strips();
      void loadSlots(conflictPending);
      conflictPending = false;
    }
    if (step === "contact") void ensureWidget();
    if (step === "otp") {
      $("#otp-phone").textContent = formatPhoneGrouped(st.phone);
      hideBanners();
      setOtp("");
      $("#otp").classList.remove("invalid");
      paintCooldown();
      syncOtpButton();
      otpInput.focus();
    }
    if (step === "confirm") renderConfirm();
  }


  // ------------------------------------------------------------------ shelf (BookingSummaryBar + SelectedServicesShelf)
  function renderShelf(step: "services" | "date" | "time"): void {
    const bar = $(`[data-sb="${step}"]`, root);
    const box = $("[data-sb-summary]", bar);
    const cta = $<HTMLButtonElement>(`#cta-${step}`);
    const list = step === "services" ? picked() : chosen();
    const t = totals(list);
    box.replaceChildren();
    if (!t.n) {
      box.append(el("p", "t-fb muted centered prompt", S.chooseAtLeast));
    } else {
      const row = el("button", "labelrow");
      row.type = "button";
      row.setAttribute("aria-expanded", String(st.expanded));
      row.innerHTML = `<span class="t-section">${S.shelfTitle}</span><span class="sp"></span><span class="t-fb muted">${pluralServices(t.n)}</span>${icon(expandMoreRounded)}`;
      row.addEventListener("click", () => {
        st.expanded = !st.expanded;
        renderShelf(step);
      });
      box.append(row);
      if (st.expanded) {
        const selList = el("div", "sel-list");
        for (const s of list) {
          const entry = el("div", "sel-entry");
          const top = el("div", "top");
          top.append(el("span", "t-strong ellipsis", s.name), el("span", "t-accent-12", priceText(s)));
          if (step === "services") {
            const x = el("button", "xbtn");
            x.type = "button";
            x.setAttribute("aria-label", fmt(S.remove, { name: s.name }));
            x.innerHTML = icon(closeRounded);
            x.addEventListener("click", () => toggle(s.id, false));
            top.append(x);
          }
          const dur = el("span", "dur t-fb muted");
          dur.innerHTML = `${icon(schedule)}${formatDuration(s.minutes)}`;
          entry.append(top, dur);
          selList.append(entry);
        }
        box.append(selList);
      }
      const rule = el("div", "rule");
      const total = el("div", "total");
      // Salon, services step: the prices are salon-wide ranges, so there is no sum; the master pages show their own subtotal.
      const noSum = salon && step === "services";
      total.append(el("span", "t-strong", S.total), el("span", "t-fb muted", formatDuration(t.minutes)), el("span", "sp"), ...(noSum ? [] : [el("span", "t-price-md", formatPriceFrom(t.price))]));
      box.append(rule, total);
      if (step === "time") {
        // Always present on the time step: before a slot is picked it is an invisible placeholder of the same height, so picking one never pushes the CTA down.
        const picked = !!(st.slot && st.day);
        const w = el("div", picked ? "chosen" : "chosen ph");
        w.innerHTML = icon(eventAvailable);
        w.append(el("span", "t-fb sec", S.booking), el("span", "t-accent-11 ellipsis grow", picked ? shortWindow() : "\u00a0"));
        if (!picked) w.setAttribute("aria-hidden", "true");
        box.append(w);
      }
    }
    cta.disabled = step === "services" ? !t.n : step === "date" ? !st.day : !st.slot;
    if (step === "time") salon?.ctaLabel();
  }

  // ------------------------------------------------------------------ services
  function toggle(id: string, on: boolean): void {
    const note = $("#cap-note");
    note.hidden = true;
    if (on && st.picked.size >= 10) {
      // The app's cap (phase 420): at most 10 services per visit; the note stays until the next change.
      note.textContent = fmt(S.cap, { count: 10 });
      note.hidden = false;
      return;
    }
    if (on) st.picked.add(id);
    else st.picked.delete(id);
    const tile = $(`#svc-list [data-id="${CSS.escape(id)}"]`);
    tile.setAttribute("aria-pressed", String(on));
    // A different service set means different slots: the chosen time is no longer valid.
    st.slot = null;
    st.slots = [];
    syncBadges();
    renderShelf("services");
    if (on) track("service_selected", { count: st.picked.size });
  }
  function syncBadges(): void {
    $$("#svc-list [data-cat-group]").forEach((g) => {
      const n = $$("[data-id][aria-pressed=true]", g).length;
      const badge = $("[data-sel-badge]", g);
      badge.hidden = n === 0;
      $("[data-sel-n]", badge).textContent = String(n);
    });
  }
  for (const tile of $$("#svc-list [data-id]")) tile.addEventListener("click", () => toggle(tile.dataset.id!, tile.getAttribute("aria-pressed") !== "true"));
  $("#cta-services").addEventListener("click", () => picked().length && go(salonMode ? "masters" : "date"));
  $("#cta-masters")?.addEventListener("click", () => salon?.commit() && go("date"));

  // ------------------------------------------------------------------ date (MonthCalendar)
  $("#wk").replaceChildren(...[0, 1, 2, 3, 4, 5, 6].map((d) => el("span", d >= 5 ? "we" : "", weekdayShort(d))));
  const daysKey = () => `${salon?.masterId() ?? ""}|${apiIds().join(",")}`;
  /** One request per (services, month window) for the whole session: in flight, answered or failed (a failure is forgotten so the next visit to the month asks again; meanwhile the UI stays all-enabled). */
  const daysRequests = new Map<string, Promise<void>>();
  /** Fetches the visible month's bookable days (window clamped to today ... today+60). Any failure leaves every date enabled. */
  /** Forget every cached answer about free times (after any booking attempt, a 409 says they were wrong). */
  function invalidateAvailability(): void {
    slotCache.clear();
    st.workDays.clear();
    daysRequests.clear();
  }
  /** Fetches one master's (or the master link's) bookable days for a month; the same request is never sent twice. */
  function fetchDays(masterId: string | undefined, ids: string[], month: number): Promise<void> {
    const key = `${masterId ?? ""}|${ids.join(",")}`;
    const v = monthView(today, month);
    const from = v.days[0] < today ? today : v.days[0];
    const lastDay = v.days[v.days.length - 1];
    const limit = addDays(today, WINDOW_DAYS);
    const to = lastDay > limit ? limit : lastDay;
    if (from > to) return Promise.resolve();
    const id = `${key}|${from}|${to}`;
    const pending = daysRequests.get(id);
    if (pending) return pending;
    const request = (async () => {
      const r = await getBookableDays(api, slug, from, to, ids, masterId);
      if (!r.ok) {
        daysRequests.delete(id); // a failed request is not remembered: the next visit to this month asks again
        return;
      }
      // Cached whatever the visitor has done meanwhile; only the render below is skipped when the answer is stale.
      const map = st.workDays.get(key) ?? new Map<string, boolean>();
      for (const d of r.data) map.set(d.date, d.working);
      st.workDays.set(key, map);
      if (key !== daysKey()) return;
      if (st.step === "date") {
        renderCalendar();
        renderShelf("date");
      }
    })();
    daysRequests.set(id, request);
    return request;
  }
  /** Fetches the visible month's bookable days (window clamped to today ... today+60). Any failure leaves every date enabled. */
  function loadWorkingDays(): Promise<void> {
    if (!chosen().length) return Promise.resolve();
    return fetchDays(salon?.masterId(), apiIds(), st.month);
  }
  function renderCalendar(): void {
    const known = st.workDays.get(daysKey());
    // A chosen day that has no free time for THESE services is dropped, whether the answer is fresh or cached; the shelf (Далі) follows at once.
    const dropped = !!st.day && known?.get(st.day) === false;
    if (dropped) {
      st.day = null;
      st.slot = null;
    }
    const v = monthView(today, st.month);
    $("#month").textContent = monthLabel(v.first);
    $<HTMLButtonElement>("#prev").disabled = st.month === 0;
    $<HTMLButtonElement>("#next").disabled = st.month >= maxOffset;
    const grid = $("#grid");
    grid.replaceChildren();
    for (let i = 0; i < v.lead; i++) grid.append(el("div", "cell"));
    for (const d of v.days) {
      const ok = inWindow(d, today) && known?.get(d) !== false;
      const sel = d === st.day;
      const we = weekdayMon0(d) >= 5;
      const cell = el("div", `cell${sel ? " sel" : ""}`);
      const b = el("button", `dbtn ${ok ? "ok" : "off"}${we ? " we" : ""}${sel ? " sel" : ""}${d === today ? " today" : ""}`);
      b.type = "button";
      b.disabled = !ok;
      b.dataset.day = d;
      b.setAttribute("aria-pressed", String(sel));
      b.setAttribute("aria-label", `${dayLong(d)}${sel ? `, ${S.selected}` : ""}`);
      b.append(el("span", "n t-cal-num", String(Number(d.slice(8)))));
      cell.append(b);
      grid.append(cell);
    }
    if (dropped) renderShelf("date");
  }
  $("#grid").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-day]");
    if (!b) return;
    st.day = b.dataset.day!;
    st.slot = null;
    renderCalendar();
    renderShelf("date");
  });
  $("#prev").addEventListener("click", () => {
    if (st.month > 0) st.month--;
    renderCalendar();
    void loadWorkingDays();
  });
  $("#next").addEventListener("click", () => {
    if (st.month < maxOffset) st.month++;
    renderCalendar();
    void loadWorkingDays();
  });
  $("#cta-date").addEventListener("click", () => st.day && go("time"));

  // ------------------------------------------------------------------ time (SlotChip groups)
  const view = (id: string, on: boolean) => ($(id).hidden = !on);
  const slotCache = new Map<string, { at: number; slots: Slot[] }>();
  const SLOT_TTL_MS = 60_000;
  async function loadSlots(conflict = false): Promise<void> {
    if (conflict) invalidateAvailability(); // a 409 says the cached lists were wrong
    if (!st.day) return go("date", false);
    view("#time-conflict", conflict);
    view("#time-error", false);
    view("#time-empty", false);
    view("#time-loading", true);
    $("#slots").replaceChildren();
    renderShelf("time");
    // The free times of a day are kept for a minute per (master, services, day): paging between masters or back to the date does not refetch.
    const cacheKey = `${daysKey()}|${st.day}`;
    const hit = slotCache.get(cacheKey);
    const fresh = !!hit && Date.now() - hit.at < SLOT_TTL_MS; // an expired entry is refetched and then replaced
    const r: Result<Slot[]> = fresh ? { ok: true, data: hit!.slots } : await getAvailability(api, slug, st.day, apiIds(), salon?.masterId());
    if (r.ok && !fresh) slotCache.set(cacheKey, { at: Date.now(), slots: r.data });
    if (st.step !== "time") return;
    view("#time-loading", false);
    if (!r.ok) {
      view("#time-error", true);
      return;
    }
    st.slots = r.data;
    // A previously chosen time that is gone (or never offered) is dropped.
    if (st.slot && !st.slots.some((s) => s.startsAt === st.slot!.startsAt)) st.slot = null;
    if (!st.slots.length) {
      view("#time-empty", true);
      renderShelf("time");
      return;
    }
    renderSlots();
    renderShelf("time");
  }
  function renderSlots(): void {
    const tpl = $<HTMLTemplateElement>("#tpl-slot").content.firstElementChild as HTMLElement;
    const groups: Record<Part, Slot[]> = { morning: [], day: [], evening: [] };
    for (const s of st.slots) groups[partOfDay(kyivTime(s.startsAt))].push(s);
    const out = $("#slots");
    out.replaceChildren();
    (["morning", "day", "evening"] as Part[]).forEach((p) => {
      if (!groups[p].length) return;
      const part = el("div", "part");
      const label = el("div", "sgroup-label");
      label.append(el("span", "t-section", S[p]), el("i"));
      const wrap = el("div", "sgroup");
      for (const s of groups[p]) {
        const chip = tpl.cloneNode(true) as HTMLButtonElement;
        const time = kyivTime(s.startsAt);
        chip.dataset.t = s.startsAt;
        chip.setAttribute("aria-pressed", String(st.slot?.startsAt === s.startsAt));
        $(".face", chip).textContent = time;
        wrap.append(chip);
      }
      part.append(label, wrap);
      out.append(part);
    });
  }
  $("#slots").addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".slot");
    if (!chip) return;
    st.slot = st.slots.find((s) => s.startsAt === chip.dataset.t) ?? null;
    view("#time-conflict", false);
    renderSlots();
    renderShelf("time");
    if (st.slot && st.day) track("slot_selected", { days_ahead: daysBetween(today, kyivDay(st.slot.startsAt)) });
  });
  $("#time-change").addEventListener("click", () => go("date"));
  $("#cta-time").addEventListener("click", () => st.slot && (salon ? salon.afterTime() : go("contact")));

  // ------------------------------------------------------------------ contact (name, surname, phone, consent, Turnstile)
  const name = $<HTMLInputElement>("#name");
  const surname = $<HTMLInputElement>("#surname");
  const phone = $<HTMLInputElement>("#phone");
  const consent = $<HTMLInputElement>("#consent");
  // The master link has one note field; the salon wizard has one per master card (built by salon.ts), so there is none here.
  const comment = document.querySelector<HTMLTextAreaElement>("#comment");
  comment?.addEventListener("input", () => {
    const clean = comment.value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    if (clean !== comment.value) comment.value = clean;
  });
  let prevDigits = "";
  phone.addEventListener("input", (e) => {
    const deleting = (e as InputEvent).inputType?.startsWith("delete") ?? false;
    let digits = nationalDigits(phone.value);
    if (deleting && digits === prevDigits) digits = digits.slice(0, -1); // Backspace over a separator removes the digit before it
    prevDigits = digits;
    phone.value = digits ? formatPhoneGrouped(digits) : "";
  });
  const phoneOk = () => nationalDigits(phone.value).length === 9;
  function setError(id: string, message: string | null): void {
    const field = $(`#f-${id}`);
    $(".ferr", field)?.remove();
    field.classList.toggle("invalid", !!message);
    if (message) {
      const f = el("div", "ferr");
      f.id = `e-${id}`;
      f.setAttribute("role", "alert");
      f.innerHTML = `${icon(errorOutline)}<span class="t-fb err"></span>`;
      $("span", f).textContent = message;
      field.append(f);
    }
  }
  function validateContact(): boolean {
    const nameBad = !cleanName(name.value);
    const surBad = !cleanName(surname.value);
    const phoneBad = !phoneOk();
    const consentBad = !consent.checked;
    setError("name", nameBad ? S.required : null);
    setError("surname", surBad ? S.required : null);
    setError("phone", phoneBad ? S.phoneErr : null);
    $("#f-consent").classList.toggle("invalid", consentBad);
    view("#consent-err", consentBad);
    const first = nameBad ? name : surBad ? surname : phoneBad ? phone : consentBad ? consent : null;
    first?.focus();
    return !first;
  }
  const banners = (prefix: string) => ["limit", "sms", "error", "wrong", "session"].map((k) => $(`#${prefix}-${k}`, document)).filter(Boolean);
  function hideBanners(): void {
    for (const b of [...banners("otp"), ...banners("cb")]) b.hidden = true;
  }
  const failBanner = (prefix: "otp" | "cb", fail: Fail): void => {
    hideBanners();
    const k = fail === "rate-limited" ? "limit" : fail === "unavailable" ? "sms" : "error";
    $(`#${prefix}-${k}`).hidden = false;
  };

  async function ensureWidget(): Promise<void> {
    if (!siteKey || widget) return;
    const host = $("#ts-widget");
    const w = await mountTurnstile(host, siteKey);
    if (!w) {
      $("#turn-err .t-fb").textContent = S.turnstileLoadErr;
      view("#turn-err", true);
      return;
    }
    widget = w;
  }
  /** A fresh Turnstile token, or null when the check is required but not passed. No site key (local) = no token needed. */
  async function turnstileToken(): Promise<{ ok: true; token: string | null } | { ok: false }> {
    if (!siteKey) return { ok: true, token: null };
    await ensureWidget();
    const token = widget ? await widget.token(8000) : null;
    return token ? { ok: true, token } : { ok: false };
  }

  function busy(btn: HTMLButtonElement, on: boolean): void {
    st.busy = on;
    btn.disabled = on;
    if (on) btn.setAttribute("aria-busy", "true");
    else btn.removeAttribute("aria-busy");
  }

  async function requestCode(from: "contact" | "otp"): Promise<void> {
    if (st.busy) return;
    const btn = $<HTMLButtonElement>(from === "contact" ? "#cta-contact" : "#otp-resend-btn");
    if (from === "contact" && !validateContact()) return;
    stopWebOtp();
    view("#turn-err", false);
    hideBanners();
    busy(btn, true);
    const phoneE164 = `+380${nationalDigits(phone.value)}`;
    const tk = await turnstileToken();
    if (!tk.ok) {
      busy(btn, false);
      $("#turn-err .t-fb").textContent = S.turnstileErr;
      if (from === "otp") go("contact", false);
      view("#turn-err", true);
      return;
    }
    const r = await sendOtp(api, phoneE164, policy, tk.token, detectOtpSmsFormat(currentEnv()));
    widget?.reset();
    busy(btn, false);
    if (!r.ok) {
      track("booking_error", { code: r.fail === "rate-limited" ? 429 : r.fail === "unavailable" ? 503 : "other" });
      if (from === "otp") {
        failBanner("otp", r.fail);
        startWebOtp(); // the old request was aborted at the click; the guest still waits for the earlier SMS
        return;
      }
      if (r.fail === "validation") {
        $("#turn-err .t-fb").textContent = S.turnstileErr;
        view("#turn-err", true);
        return;
      }
      failBanner("cb", r.fail);
      return;
    }
    st.phone = phoneE164;
    track("otp_requested");
    startCooldown();
    if (from === "contact") go("otp");
    startWebOtp();
  }
  $("#contact-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void requestCode("contact");
  });
  // A pasted tab / control character never reaches the backend: names are cleaned as they are typed (and again when sent).
  for (const i of [name, surname]) i.addEventListener("input", () => { const v = typingName(i.value); if (v !== i.value) i.value = v; });
  for (const i of [name, surname, phone]) i.addEventListener("input", () => $(`#f-${i.id}`).classList.contains("invalid") && validateContact());
  consent.addEventListener("change", () => $("#f-consent").classList.contains("invalid") && validateContact());

  // ------------------------------------------------------------------ otp (OtpCodeField, resend row)
  // ONE real input is the focus / iOS one-time-code autofill / paste / WebOTP target; the six cells are aria-hidden mirrors of its value.
  const otpInput = $<HTMLInputElement>("#otp-input");
  const otpCells = $$("#otp .otp-cell");
  const code = () => otpInput.value;
  function syncOtpButton(): void {
    $<HTMLButtonElement>("#cta-otp").disabled = code().length !== 6;
  }
  let otpPrev = ""; // the value the cells last mirrored: tells "autofill delivered a code" from "the guest typed a digit"
  /** Writes a (sanitised, <= 6 digits) code into the input and repaints the cells. */
  function setOtp(v: string): void {
    const d = v.replace(/\D/g, "").slice(0, 6);
    otpPrev = d;
    if (otpInput.value !== d) otpInput.value = d;
    const active = Math.min(d.length, 5);
    otpCells.forEach((c, k) => {
      const ch = d[k] ?? "";
      if (c.textContent !== ch) c.textContent = ch;
      c.classList.toggle("on", k === active);
    });
  }
  const otpEdited = (): void => {
    $("#otp").classList.remove("invalid");
    $("#otp-wrong").hidden = true;
    syncOtpButton();
  };
  /** Sanitise -> mirror cells -> submit when autofill / paste delivered a whole code in one go (typing the last digit by hand does not). */
  function syncOtp(v: string = otpInput.value): void {
    const before = otpPrev;
    setOtp(v);
    otpEdited();
    const now = code();
    if (st.step !== "otp" || now.length !== 6 || now === before) return;
    if (before.length < 6 ? now.length - before.length > 1 : true) void submitOtp(); // submitOtp is single-flight (st.busy) and aborts WebOTP
  }
  otpInput.addEventListener("input", () => syncOtp());
  // WKWebView sets `value` without an input event: catch it when the field or the page regains / loses attention.
  for (const ev of ["change", "focus", "blur"]) otpInput.addEventListener(ev, () => syncOtp());
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && st.step === "otp" && syncOtp());
  otpInput.addEventListener("paste", (e) => {
    // maxlength would cut "123 456" to "123 45" before sanitising: take the digits ourselves.
    const d = (e.clipboardData?.getData("text") ?? "").replace(/\D/g, "");
    if (!d) return;
    e.preventDefault();
    syncOtp(d);
  });
  setOtp("");
  function startCooldown(): void {
    cooldown = 60;
    clearInterval(cooldownTimer);
    paintCooldown();
    cooldownTimer = window.setInterval(() => {
      cooldown--;
      paintCooldown();
      if (cooldown <= 0) clearInterval(cooldownTimer);
    }, 1000);
  }
  function paintCooldown(): void {
    const waiting = cooldown > 0;
    $("#otp-wait").hidden = !waiting;
    $("#otp-wait").textContent = fmt(S.wait, { sec: cooldown });
    $("#otp-resend-btn").hidden = waiting;
  }
  $("#otp-resend-btn").addEventListener("click", () => void requestCode("otp"));
  // WebOTP (Chromium/Android): the SMS ends with `@beautica.app #<code>` (backend 389); one tap fills the code and submits through
  // the same path as the button. Any rejection / unsupported browser is a silent no-op. Only ever started on the OTP step.
  function stopWebOtp(): void {
    window.clearTimeout(otpRearm);
    otpAbort?.abort();
    otpAbort = undefined;
  }
  function startWebOtp(): void {
    stopWebOtp();
    if (st.step !== "otp" || !("OTPCredential" in window) || !navigator.credentials?.get) return;
    const ac = new AbortController();
    otpAbort = ac;
    try {
      const get = navigator.credentials.get({ otp: { transport: ["sms"] }, signal: ac.signal } as CredentialRequestOptions);
      void Promise.resolve(get)
        .then((cred) => {
          const d = String((cred as { code?: string } | null)?.code ?? "").replace(/\D/g, "");
          if (ac.signal.aborted || otpAbort !== ac || st.step !== "otp" || d.length !== 6) return;
          if (st.busy) return void (otpRearm = window.setTimeout(startWebOtp, 300)); // a request is in flight: keep the code, listen again shortly
          otpAbort = undefined;
          setOtp(d);
          otpEdited();
          void submitOtp();
        })
        .catch(() => {});
    } catch {
      /* unsupported / blocked: manual entry stays */
    }
  }
  window.addEventListener("pagehide", stopWebOtp);
  // In-app browsers: one dismissible line under the input (remembered for the tab). Storage may throw: then it simply shows again.
  const HINT_KEY = "beautica.otpHintClosed";
  const hintClosed = (): boolean => {
    try {
      return sessionStorage.getItem(HINT_KEY) === "1";
    } catch {
      return false;
    }
  };
  if (isInAppBrowser(currentEnv()) && !hintClosed()) $("#otp-hint").hidden = false;
  $("#otp-hint-x").addEventListener("click", () => {
    $("#otp-hint").hidden = true;
    try {
      sessionStorage.setItem(HINT_KEY, "1");
    } catch {
      /* storage blocked: the hint shows again next time */
    }
  });
  $("#cta-otp").addEventListener("click", () => void submitOtp());
  async function submitOtp(): Promise<void> {
    if (st.busy || code().length !== 6) return;
    stopWebOtp();
    const btn = $<HTMLButtonElement>("#cta-otp");
    hideBanners();
    busy(btn, true);
    const phoneAtSend = st.phone;
    const r = await verifyOtp(api, phoneAtSend, code());
    busy(btn, false);
    // The guest left the step (Back) or changed the phone while the check was in flight: drop the answer, keep no token.
    if (st.step !== "otp" || st.phone !== phoneAtSend) return;
    if (!r.ok) {
      track("otp_failed");
      if (r.fail === "unauthorized" || r.fail === "validation") {
        $("#otp").classList.add("invalid");
        $("#otp-wrong").hidden = false;
      } else failBanner("otp", r.fail);
      syncOtpButton();
      startWebOtp(); // wrong code: listen for the next SMS (still on the OTP step, checked above)
      return;
    }
    st.guestToken = r.data;
    track("otp_verified");
    go("confirm");
  }

  // ------------------------------------------------------------------ confirm (BookingSummaryCards + BookingRecap)
  /** The master link's own view of the booking (the picked services, the live day and time, the one note). */
  const masterView = (): RecapView => ({ services: chosen(), day: st.day!, slot: st.slot!, head: true });
  /** One compact summary (confirm and done): address, «Коли» on one line, one row per service (name, duration, price), «Разом». */
  function recap(into: HTMLElement, v: RecapView = masterView()): void {
    const t = totals(v.services);
    const sep = `<div class="rule"></div>`;
    let h = lrow(S.whenLabel, `${dayLong(v.day)} · ${kyivTime(v.slot.startsAt)}–${kyivTime(v.slot.endsAt)}`);
    if (v.head) {
      if (salonName) h += lrow(S.salonLabel, salonName);
      // Independent masters have a street address (and a note): the app's «Адреса» row; otherwise just the city.
      if (address) h += lrow(S.addressLabel, [city, address].filter(Boolean).join(", "), note);
      else if (city) h += lrow(S.cityLabel, city);
    }
    h += sep;
    into.innerHTML = h;
    v.services.forEach((s, i, all) => {
      const row = el("div", "recap-row dense");
      const grow = el("div", "grow");
      grow.append(el("div", "t-strong11", s.name), el("div", "t-fb muted", formatDuration(s.minutes)));
      row.append(grow, el("span", "t-accent-11", priceText(s)));
      into.append(row);
      if (i < all.length - 1) into.append(el("div", "recap-div"));
    });
    const sum = el("div", "total-row");
    const l = el("span", "l");
    l.append(el("span", "t-name-13w800", S.totalLabel), el("span", "t-fb muted", formatDuration(t.minutes)));
    sum.append(l, el("span", "t-price-md", formatPriceFrom(t.price)));
    into.append(el("div", "recap-sum"), sum);
  }
  function renderConfirm(): void {
    if (salon) salon.renderConfirm();
    else recap($("#confirm-card"));
    view("#submit-error", false);
    if (unsure.has("")) showUncertain();
  }
  $("#cta-confirm").addEventListener("click", async () => {
    if (salon) return void salon.submit($<HTMLButtonElement>("#cta-confirm"));
    if (st.busy || !st.slot) return;
    if (!st.guestToken) return sessionExpired(); // cleared when the page was hidden
    const btn = $<HTMLButtonElement>("#cta-confirm");
    view("#submit-error", false);
    busy(btn, true);
    const slot = unsure.get("")?.slot ?? st.slot; // after a request of unknown outcome only the SAME slot is ever sent again
    const r = await createBooking(api, slug, st.guestToken, { serviceIds: chosen().map((s) => s.id), startsAt: slot.startsAt, name: cleanName(name.value), surname: cleanName(surname.value), policyVersion: policy, clientComment: cleanComment(comment!.value) });
    busy(btn, false);
    invalidateAvailability();
    if (!r.ok) return void bookingFailed(r, slot);
    unsure.delete("");
    clearMarker("master", slug);
    st.done = true;
    st.guestToken = null;
    track("booking_confirmed", { services_count: totals().n });
    renderDone(r.data);
    history.replaceState({ bk: "done" }, "", location.href);
    show("done");
  });
  /** «вівторок, 27 жовтня, 10:30»: the time in the «Можливо, ви вже записані на …» notice. */
  const whenLabel = (day: string, slot: Slot): string => `${dayLong(day)}, ${kyivTime(slot.startsAt)}`;
  /** The «may exist» state of the master link: frozen slot and fields, no way back, the check-SMS message. */
  function showUncertain(): void {
    st.frozen = true;
    lockContact();
    for (const b of $$("[data-screen=confirm] [data-back]")) b.hidden = true;
    comment!.readOnly = true; // the request that may exist carried this note
    $("#cta-confirm .lbl").textContent = S.retry;
    $("#submit-error-text").textContent = fmt(S.uncertain, { master: masterName });
    view("#submit-error", true);
  }
  function bookingFailed(r: { fail: Fail; status?: number }, slot: Slot): void {
    const fail = r.fail;
    track("booking_error", { code: fail === "conflict" ? 409 : fail === "rate-limited" ? 429 : fail === "unavailable" ? 503 : fail === "provider-unavailable" ? "blocked" : "other" });
    // A dropped answer / 502 / 504 (or any failure of the resend after one, e.g. 409 «probably booked by you»): never offer another time.
    if (mayExist(r, unsure.has(""))) {
      if (!unsure.has("")) {
        unsure.set("", { slot, day: st.day ?? "" });
        saveMarker("master", slug, { slotStartIso: slot.startsAt, label: whenLabel(st.day ?? kyivDay(slot.startsAt), slot) }); // survives a reload (no personal data)
      }
      return showUncertain();
    }
    if (fail === "conflict") {
      st.slot = null;
      conflictPending = true;
      go("time", false);
      return;
    }
    if (fail === "unauthorized") return sessionExpired();
    const msg = fail === "provider-unavailable" ? S.blockedMaster : fail === "validation" ? S.invalid : fail === "rate-limited" ? S.limit : fail === "unavailable" ? fmt(S.unavailable, { email: S.supportEmail }) : S.error;
    $("#submit-error-text").textContent = msg;
    view("#submit-error", true);
  }
  // The guest token is a bearer credential: it does not survive the page being hidden (tab closed, navigation, bfcache).
  window.addEventListener("pagehide", () => (st.guestToken = null));
  /** Once a booking exists (or may exist) the rest is booked under the same name and phone: the fields freeze, the code step loses its way back. */
  function lockContact(): void {
    for (const i of [name, surname, phone]) i.readOnly = true;
    for (const b of $$("[data-screen=otp] [data-back]")) b.hidden = true;
  }
  function sessionExpired(): void {
    st.guestToken = null;
    go("otp", false);
    $("#otp-session").hidden = false;
  }

  // ------------------------------------------------------------------ done
  /** The «Додати в календар» chooser: Google opens its "new event" page (any browser, incl. in-app webviews such as Telegram), the Apple link (GET /api/ics, served `inline`)
   *  is for iPhone / macOS (inside the iOS Instagram / Facebook browser it is an x-safari-https:// link plus a hint). Order by device, both always reachable.
   *  Content: time, master, services, place and the cancel link (the guest already gets it by SMS; it goes to the calendar app only), never a phone or name. */
  function calendarButton(b: { startsAt: string; minutes: number; master: string; services: string; cancelPath?: string | null }): HTMLElement {
    const wrap = el("div", "calwrap");
    wrap.append(el("p", "t-label", S.calendar));
    const links = calendarLinks({
      startsAt: b.startsAt,
      minutes: b.minutes,
      title: fmt(S.icsSummary, { master: b.master }),
      description: fmt(S.icsDescription, { services: b.services }),
      location: [salonName, city, address].filter(Boolean).join(", "),
      ...(b.cancelPath ? { cancel: { url: `${location.origin}${b.cancelPath}`, label: S.icsCancel } } : {}),
    }, navigator.userAgent, location.origin);
    const iab = isIosInApp(navigator.userAgent);
    const labels = { google: S.calendarGoogle, apple: S.calendarApple } as const;
    for (const kind of calendarOrder(navigator.userAgent)) {
      const btn = el("a", "calbtn");
      btn.href = links[kind];
      btn.dataset.cal = kind;
      btn.rel = "noopener noreferrer";
      if (kind !== "apple") btn.target = "_blank"; // Apple: top-level navigation (also the x-safari-https:// case)
      btn.innerHTML = `<svg class="mi" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${brandMarks[kind === "google" ? "google-calendar" : "apple-calendar"]}</svg><span class="t-strong115"></span>`;
      $("span", btn).textContent = labels[kind];
      wrap.append(btn);
    }
    if (iab) wrap.append(el("p", "t-body centered", S.calendarIabHint));
    return wrap;
  }
  function renderDone(b: { startsAt: string; durationMinutes: number; cancelUrl: string | null; telegram: TelegramAvailability | null }): void {
    const card = $("#done-card");
    recap(card);
    const minutes = totals().minutes || b.durationMinutes;
    const cPath = cancelPath(b.cancelUrl);
    card.append(el("div", "rule"), calendarButton({ startsAt: b.startsAt, minutes, master: masterName, services: chosen().map((s) => s.name).join(", "), cancelPath: cPath }));
    mountReminders({ root: document.getElementById("done-reminders"), api, token: cancelToken(cPath), telegram: b.telegram, navigate: (u) => location.assign(u), track });
  }

  if (salonMode) {
    const core: Core = {
      root, S, api, slug, policy, services, st, $, $$, el, icon, fmt, busy, lrow, recap, calendarButton, sessionExpired,
      go: (step, push) => go(step as Step, push),
      show: (step) => show(step as Step),
      conflict: () => {
        conflictPending = true;
        go("time");
      },
      name: () => cleanName(name.value),
      surname: () => cleanName(surname.value),
      salonName, city, address, note,
      lockContact,
      whenLabel,
      invalidateSlots: invalidateAvailability,
    };
    salon = salonMod!.createSalon(core, salonInfo!);
  }
  return { open: () => go("services") };
}
