// The guest booking island (phase 009). Vanilla TS, no router: one screen visible at a time, the step kept in history.state so
// the back button works, the URL never changes. Secrets live in memory only: the guest token, the name and the phone are never
// written to storage, URLs, logs or analytics.
import { formatDuration, formatPriceFrom, pluralServices } from "../../lib/booking/format";
import { formatPhoneGrouped, nationalDigits } from "../../lib/phone";
import { dayLong, dayShort, daysBetween, inWindow, kyivDay, kyivTime, kyivToday, maxMonthOffset, monthLabel, monthView, partOfDay, weekdayMon0, weekdayShort, type Part } from "./calendar";
import { cancelPath, createBooking, getAvailability, sendOtp, verifyOtp, type Fail, type Slot } from "./api";
import { buildIcs, downloadIcs } from "./ics";
import { mountTurnstile, type Widget } from "./turnstile";
import { closeRounded, errorOutline, eventAvailable, expandMoreRounded, schedule } from "../../lib/icons/materialPaths";
import { track } from "../track";

type Step = "profile" | "services" | "date" | "time" | "contact" | "otp" | "confirm" | "done";
interface Svc {
  id: string;
  name: string;
  minutes: number;
  price: number;
}
type Strings = Record<string, string>;

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector<T>(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(sel)];
const fmt = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

function icon(path: string): string {
  return `<svg class="mi" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"></path></svg>`;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function initBooking(root: HTMLElement): void {
  const api = root.dataset.api ?? "";
  const slug = root.dataset.slug ?? "";
  const siteKey = root.dataset.siteKey ?? "";
  const policy = root.dataset.policy ?? "";
  const salon = root.dataset.salon ?? "";
  const city = root.dataset.city ?? "";
  const masterName = root.dataset.master ?? "";
  const S: Strings = JSON.parse($("#book-i18n").textContent ?? "{}");
  const services: Svc[] = $$("#svc-list [data-id]").map((b) => ({ id: b.dataset.id!, name: b.dataset.name!, minutes: Number(b.dataset.min), price: Number(b.dataset.price) }));
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
    guestToken: null as string | null,
    phone: "", // +380XXXXXXXXX
    busy: false,
    done: false,
  };
  let widget: Widget | null = null;
  let cooldown = 0;
  let cooldownTimer = 0;
  let conflictPending = false; // set when the booking answered 409: the time step re-opens with its message

  const chosen = (): Svc[] => services.filter((s) => st.picked.has(s.id));
  const totals = () => {
    const c = chosen();
    return { n: c.length, minutes: c.reduce((a, s) => a + s.minutes, 0), price: c.reduce((a, s) => a + s.price, 0) };
  };
  const endIso = () => st.slot?.endsAt ?? "";
  const shortWindow = () => (st.day && st.slot ? `${dayShort(st.day)} · ${kyivTime(st.slot.startsAt)}–${kyivTime(endIso())}` : "");

  // ------------------------------------------------------------------ navigation
  const screens = $$("[data-screen]", root);
  function show(step: Step): void {
    st.step = step;
    for (const s of screens) s.hidden = s.dataset.screen !== step;
    window.scrollTo(0, 0);
    const heading = $<HTMLElement>("[data-step-heading]", screens.find((s) => s.dataset.screen === step)!);
    // Moved to the step heading so a screen reader announces the new step (the heading has tabindex -1).
    if (step !== "profile" && heading) heading.focus({ preventScroll: true });
  }
  function go(step: Step, push = true): void {
    if (push && history.state?.bk !== step) history.pushState({ bk: step }, "", location.href);
    show(step);
    onEnter(step);
  }
  window.addEventListener("popstate", (e) => {
    if (st.done) return void go("done", false); // a finished booking never returns to a step that could submit again
    const step = (e.state?.bk as Step | undefined) ?? "profile";
    show(step);
    onEnter(step);
  });
  // A reload keeps history.state but not the in-memory choices: always restart on the profile.
  if (history.state?.bk) history.replaceState(null, "", location.href);
  for (const b of $$("[data-back]", root)) b.addEventListener("click", () => (history.state?.bk ? history.back() : go("profile", false)));

  function onEnter(step: Step): void {
    if (step === "services") renderShelf("services");
    if (step === "date") {
      renderCalendar();
      renderShelf("date");
    }
    if (step === "time") {
      void loadSlots(conflictPending);
      conflictPending = false;
    }
    if (step === "contact") void ensureWidget();
    if (step === "otp") {
      $("#otp-phone").textContent = formatPhoneGrouped(st.phone);
      hideBanners();
      $$<HTMLInputElement>("#otp input").forEach((i) => (i.value = ""));
      $("#otp").classList.remove("invalid");
      paintCooldown();
      syncOtpButton();
      $<HTMLInputElement>("#otp input").focus();
    }
    if (step === "confirm") renderConfirm();
  }

  $("#book-cta").addEventListener("click", () => go("services"));
  $("[data-nojs]")?.setAttribute("hidden", "");
  $("[data-book-cta]").hidden = false;

  // ------------------------------------------------------------------ shelf (BookingSummaryBar + SelectedServicesShelf)
  function renderShelf(step: "services" | "date" | "time"): void {
    const bar = $(`[data-sb="${step}"]`, root);
    const box = $("[data-sb-summary]", bar);
    const cta = $<HTMLButtonElement>(`#cta-${step}`);
    const t = totals();
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
        const list = el("div", "sel-list");
        for (const s of chosen()) {
          const entry = el("div", "sel-entry");
          const top = el("div", "top");
          top.append(el("span", "t-strong ellipsis", s.name), el("span", "t-accent-12", formatPriceFrom(s.price)));
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
          list.append(entry);
        }
        box.append(list);
      }
      const rule = el("div", "rule");
      const total = el("div", "total");
      total.append(el("span", "t-strong", S.total), el("span", "t-fb muted", formatDuration(t.minutes)), el("span", "sp"), el("span", "t-price-md", formatPriceFrom(t.price)));
      box.append(rule, total);
      if (step === "time" && st.slot && st.day) {
        const w = el("div", "chosen");
        w.innerHTML = icon(eventAvailable);
        w.append(el("span", "t-fb sec", S.booking), el("span", "t-accent-11 ellipsis grow", shortWindow()));
        box.append(w);
      }
    }
    cta.disabled = step === "services" ? !t.n : step === "date" ? !st.day : !st.slot;
  }

  // ------------------------------------------------------------------ services
  function toggle(id: string, on: boolean): void {
    if (on && st.picked.size >= 10) return;
    if (on) st.picked.add(id);
    else st.picked.delete(id);
    const tile = $(`#svc-list [data-id="${CSS.escape(id)}"]`);
    tile.setAttribute("aria-pressed", String(on));
    // A different service set means different slots: the chosen time is no longer valid.
    st.slot = null;
    st.slots = [];
    renderShelf("services");
    if (on) track("service_selected", { count: st.picked.size });
  }
  for (const tile of $$("#svc-list [data-id]")) tile.addEventListener("click", () => toggle(tile.dataset.id!, tile.getAttribute("aria-pressed") !== "true"));
  $("#cta-services").addEventListener("click", () => totals().n && go("date"));

  // ------------------------------------------------------------------ date (MonthCalendar)
  $("#wk").replaceChildren(...[0, 1, 2, 3, 4, 5, 6].map((d) => el("span", d >= 5 ? "we" : "", weekdayShort(d))));
  function renderCalendar(): void {
    const v = monthView(today, st.month);
    $("#month").textContent = monthLabel(v.first);
    $<HTMLButtonElement>("#prev").disabled = st.month === 0;
    $<HTMLButtonElement>("#next").disabled = st.month >= maxOffset;
    const grid = $("#grid");
    grid.replaceChildren();
    for (let i = 0; i < v.lead; i++) grid.append(el("div", "cell"));
    for (const d of v.days) {
      const ok = inWindow(d, today);
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
  });
  $("#next").addEventListener("click", () => {
    if (st.month < maxOffset) st.month++;
    renderCalendar();
  });
  $("#cta-date").addEventListener("click", () => st.day && go("time"));

  // ------------------------------------------------------------------ time (SlotChip groups)
  const view = (id: string, on: boolean) => ($(id).hidden = !on);
  async function loadSlots(conflict = false): Promise<void> {
    if (!st.day) return go("date", false);
    view("#time-conflict", conflict);
    view("#time-error", false);
    view("#time-empty", false);
    view("#time-loading", true);
    $("#slots").replaceChildren();
    renderShelf("time");
    const r = await getAvailability(api, slug, st.day, chosen().map((s) => s.id));
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
  $("#cta-time").addEventListener("click", () => st.slot && go("contact"));

  // ------------------------------------------------------------------ contact (name, surname, phone, consent, Turnstile)
  const name = $<HTMLInputElement>("#name");
  const surname = $<HTMLInputElement>("#surname");
  const phone = $<HTMLInputElement>("#phone");
  const consent = $<HTMLInputElement>("#consent");
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
    const nameBad = !name.value.trim();
    const surBad = !surname.value.trim();
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
    const r = await sendOtp(api, phoneE164, policy, tk.token);
    widget?.reset();
    busy(btn, false);
    if (!r.ok) {
      track("booking_error", { code: r.fail === "rate-limited" ? 429 : r.fail === "unavailable" ? 503 : "other" });
      if (from === "otp") {
        failBanner("otp", r.fail);
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
  }
  $("#contact-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void requestCode("contact");
  });
  for (const i of [name, surname, phone]) i.addEventListener("input", () => $(`#f-${i.id}`).classList.contains("invalid") && validateContact());
  consent.addEventListener("change", () => $("#f-consent").classList.contains("invalid") && validateContact());

  // ------------------------------------------------------------------ otp (OtpCodeField, resend row)
  const cells = $$<HTMLInputElement>("#otp input");
  const code = () => cells.map((c) => c.value).join("");
  function syncOtpButton(): void {
    $<HTMLButtonElement>("#cta-otp").disabled = code().length !== 6;
  }
  cells.forEach((c, i) => {
    c.addEventListener("input", () => {
      const d = c.value.replace(/\D/g, "");
      if (d.length > 1) {
        // Autofill / SMS suggestion puts the whole code into one cell.
        d.slice(0, 6)
          .split("")
          .forEach((ch, k) => (cells[k]!.value = ch));
        cells[Math.min(d.length, 5)]!.focus();
      } else {
        c.value = d;
        if (d && cells[i + 1]) cells[i + 1]!.focus();
      }
      $("#otp").classList.remove("invalid");
      $("#otp-wrong").hidden = true;
      syncOtpButton();
    });
    c.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !c.value && cells[i - 1]) cells[i - 1]!.focus();
    });
    c.addEventListener("paste", (e) => {
      const d = (e.clipboardData?.getData("text") ?? "").replace(/\D/g, "").slice(0, 6);
      if (d.length > 1) {
        e.preventDefault();
        cells.forEach((x, k) => (x.value = d[k] ?? ""));
        cells[Math.min(d.length, 5)]!.focus();
        syncOtpButton();
      }
    });
  });
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
  $("#cta-otp").addEventListener("click", async () => {
    if (st.busy || code().length !== 6) return;
    const btn = $<HTMLButtonElement>("#cta-otp");
    hideBanners();
    busy(btn, true);
    const r = await verifyOtp(api, st.phone, code());
    busy(btn, false);
    if (!r.ok) {
      track("otp_failed");
      if (r.fail === "unauthorized" || r.fail === "validation") {
        $("#otp").classList.add("invalid");
        $("#otp-wrong").hidden = false;
      } else failBanner("otp", r.fail);
      syncOtpButton();
      return;
    }
    st.guestToken = r.data;
    track("otp_verified");
    go("confirm");
  });

  // ------------------------------------------------------------------ confirm (BookingSummaryCards + BookingRecap)
  function lrow(label: string, value: string): string {
    const d = el("div", "lrow");
    d.append(el("span", "lbl t-label", label), el("span", "val t-value-12", value));
    return d.outerHTML;
  }
  function recap(into: HTMLElement, compact: boolean): void {
    const t = totals();
    const sep = `<div class="rule${compact ? " dense" : ""}"></div>`;
    const day = st.day!;
    let h = "";
    if (salon) h += lrow(S.salonLabel, salon) + sep;
    if (city) h += lrow(S.cityLabel, city) + sep;
    h += lrow(S.dateLabel, dayLong(day)) + `<div class="g-sm"></div>` + lrow(S.timeLabel, `${kyivTime(st.slot!.startsAt)}–${kyivTime(endIso())}`) + sep;
    into.innerHTML = h;
    const head = el("div", "row");
    head.append(el("span", "t-label", S.servicesLabel), el("span", "sp"), el("span", "t-fb muted", pluralServices(t.n)));
    into.append(head, el("div", "g-xs"));
    chosen().forEach((s, i, all) => {
      const row = el("div", `recap-row${compact ? " dense" : ""}`);
      const grow = el("div", "grow");
      grow.append(el("div", compact ? "t-strong11" : "t-strong115", s.name), el("div", "t-fb muted", formatDuration(s.minutes)));
      row.append(grow, el("span", compact ? "t-accent-11" : "t-accent-12", formatPriceFrom(s.price)));
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
    $("#c-name").textContent = `${name.value.trim()} ${surname.value.trim()}`;
    $("#c-phone").textContent = formatPhoneGrouped(st.phone);
    recap($("#confirm-card"), false);
    view("#submit-error", false);
  }
  $("#cta-confirm").addEventListener("click", async () => {
    if (st.busy || !st.guestToken || !st.slot) return;
    const btn = $<HTMLButtonElement>("#cta-confirm");
    view("#submit-error", false);
    busy(btn, true);
    const r = await createBooking(api, slug, st.guestToken, { serviceIds: chosen().map((s) => s.id), startsAt: st.slot.startsAt, name: name.value.trim(), surname: surname.value.trim(), policyVersion: policy });
    busy(btn, false);
    if (!r.ok) return void bookingFailed(r.fail);
    st.done = true;
    st.guestToken = null;
    track("booking_confirmed", { services_count: totals().n });
    renderDone(r.data);
    history.replaceState({ bk: "done" }, "", location.href);
    show("done");
  });
  function bookingFailed(fail: Fail): void {
    track("booking_error", { code: fail === "conflict" ? 409 : fail === "rate-limited" ? 429 : fail === "unavailable" ? 503 : "other" });
    if (fail === "conflict") {
      st.slot = null;
      conflictPending = true;
      go("time", false);
      return;
    }
    if (fail === "unauthorized") {
      st.guestToken = null;
      go("otp", false);
      $("#otp-session").hidden = false;
      return;
    }
    const msg = fail === "validation" ? S.invalid : fail === "rate-limited" ? S.limit : fail === "unavailable" ? fmt(S.unavailable, { email: S.supportEmail }) : S.error;
    $("#submit-error-text").textContent = msg;
    view("#submit-error", true);
  }

  // ------------------------------------------------------------------ done
  function renderDone(b: { startsAt: string; durationMinutes: number; cancelUrl: string | null }): void {
    const card = $("#done-card");
    recap(card, true);
    const wrap = el("div", "calwrap");
    const btn = el("button", "calbtn");
    btn.type = "button";
    btn.innerHTML = `<svg class="mi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M8 3v3M16 3v3M5 9.5h14M12.5 20H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v5.5M18 15.5v5M15.5 18h5"></path></svg><span class="t-strong115"></span>`;
    $("span", btn).textContent = S.calendar;
    const minutes = totals().minutes || b.durationMinutes;
    btn.addEventListener("click", () =>
      downloadIcs(buildIcs({ uid: crypto.randomUUID(), startsAt: b.startsAt, minutes, summary: fmt(S.icsSummary, { master: masterName }), description: fmt(S.icsDescription, { services: chosen().map((s) => s.name).join(", ") }), location: [salon, city].filter(Boolean).join(", ") }), "beautica-booking.ics"),
    );
    wrap.append(btn);
    card.append(el("div", "rule dense"), wrap);
    const path = cancelPath(b.cancelUrl);
    const cancel = $<HTMLAnchorElement>("#done-cancel");
    if (path) {
      cancel.href = path;
      cancel.hidden = false;
    }
  }

}
