// Guest review island (phase 019). Star radios per service, comment counter, submit, opt-out; the screens are already in the HTML.
// Token hygiene: the token is read from the address bar, sent only to the API (path of a credential-less fetch, no-referrer), never stored
// (no storage, no cookie, no analytics, no console output). After a successful review the address is replaced by /r/ so back / refresh cannot reuse it.
import type { Fail } from "../booking/api";
import { optOutReviews, submitReview } from "./api";
import type { Widget } from "../booking/turnstile";

type Screen = "form" | "success" | "already" | "invalid" | "optout-confirm" | "optout-done";
interface Strings {
  sending: string;
  cta: string;
  counter: string;
  words: string[];
  errNetwork: string;
  errLimit: string;
  errValidation: string;
  errTurnstile: string;
  errGeneric: string;
  optoutErr: string;
}

const root = document.querySelector<HTMLElement>("[data-review-root]");
const form = root?.querySelector<HTMLElement>('[data-screen="form"]');
// An already-reviewed page renders no form (no island to init): the token is dead, scrub it here.
if (root?.querySelector('[data-screen="already"]:not([hidden])')) history.replaceState(null, "", "/r/");
if (root && form) init(root, form);

function init(root: HTMLElement, formScreen: HTMLElement): void {
  const S: Strings = JSON.parse(document.getElementById("review-i18n")?.textContent ?? "{}");
  const api = root.dataset.api ?? "";
  const siteKey = root.dataset.siteKey ?? "";
  const max = Number(root.dataset.max ?? 2000);
  const token = /^\/r\/([A-Za-z0-9_-]{16,128})$/.exec(location.pathname)?.[1] ?? null;
  const $ = <T extends HTMLElement>(sel: string, from: ParentNode = root): T => from.querySelector<T>(sel)!;
  const groups = [...root.querySelectorAll<HTMLElement>("[data-svc]")];
  const submit = $<HTMLButtonElement>("#rv-submit");
  const label = $<HTMLElement>(".lbl", submit);
  const comment = $<HTMLTextAreaElement>("#comment");
  const errBox = $("#rv-error");
  const widgets: { form?: Widget | null; optout?: Widget | null } = {};
  const loading: { form?: Promise<Widget | null>; optout?: Promise<Widget | null> } = {};
  let busy = false;

  // ---- screens
  const show = (screen: Screen): void => {
    for (const s of root.querySelectorAll<HTMLElement>("[data-screen]")) s.hidden = s.dataset.screen !== screen;
    const heading = root.querySelector<HTMLElement>(`[data-screen="${screen}"] [data-step-heading], [data-screen="${screen}"] h1`);
    heading?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  };

  // The token is dead once the visit is reviewed / opted out: scrub it from the address bar (back / refresh cannot reuse it).
  const scrub = (): void => history.replaceState(null, "", "/r/");

  // ---- star radios (roving tabindex, arrow keys), one group per service of the visit
  const rate = (g: HTMLElement, v: number): void => {
    g.dataset.v = v ? String(v) : "";
    for (const b of g.querySelectorAll<HTMLButtonElement>(".starbtn")) {
      const n = Number(b.dataset.v);
      b.dataset.on = String(n <= v);
      b.setAttribute("aria-checked", String(n === v));
      b.tabIndex = n === v || (!v && n === 1) ? 0 : -1;
    }
    $("[data-word]", g).textContent = S.words[v] ?? "";
    sync();
  };
  const sync = (): void => {
    $("#counter").textContent = S.counter.replace("{n}", String(comment.value.length));
    submit.disabled = busy || !groups.every((g) => Number(g.dataset.v) > 0);
  };
  for (const g of groups) {
    for (const b of g.querySelectorAll<HTMLButtonElement>(".starbtn")) b.disabled = false; // inert without script
    g.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>(".starbtn");
      if (b) rate(g, Number(b.dataset.v));
    });
    g.addEventListener("keydown", (e) => {
      const d = ({ ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 } as Record<string, number>)[e.key];
      if (!d) return;
      e.preventDefault();
      const v = Math.min(5, Math.max(1, (Number(g.dataset.v) || 0) + d));
      rate(g, v);
      $<HTMLButtonElement>(`.starbtn[data-v="${v}"]`, g).focus();
    });
  }
  comment.addEventListener("input", sync);
  sync();

  // ---- Turnstile: loaded at the first sign of intent (a star, the field, the opt-out), never on page load
  // The loader is a dynamic import (not on the page-load path); the in-flight promise is kept so a tap on «Надіслати» during the load waits for the widget.
  const ensure = (which: "form" | "optout"): Promise<Widget | null> | undefined => {
    if (!siteKey) return undefined;
    if (loading[which]) return loading[which];
    widgets[which] = null;
    const host = $(which === "form" ? "#ts-form" : "#ts-optout");
    return (loading[which] = import("../booking/turnstile")
      .then(({ mountTurnstile, REVIEW_TURNSTILE_ACTION }) => mountTurnstile(host, siteKey, REVIEW_TURNSTILE_ACTION))
      .then((w) => (widgets[which] = w)));
  };
  // The opt-out link is not intent to submit: it loads its own widget on the confirm screen, never the form's.
  const intent = (e: Event): void => {
    if ((e.target as Element).closest("#rv-optout")) return;
    formScreen.removeEventListener("pointerdown", intent);
    formScreen.removeEventListener("focusin", intent);
    void ensure("form");
  };
  formScreen.addEventListener("pointerdown", intent);
  formScreen.addEventListener("focusin", intent);
  /** The token for one request: none when no site key is configured; null = the widget failed or timed out. */
  const turnstileToken = async (which: "form" | "optout"): Promise<string | null | undefined> => {
    if (!siteKey) return undefined;
    await ensure(which);
    const w = widgets[which];
    return w ? w.token(15000) : null;
  };

  // ---- submit
  const failText = (fail: Fail): string => (fail === "network" ? S.errNetwork : fail === "rate-limited" ? S.errLimit : fail === "validation" ? S.errValidation : S.errGeneric);
  const setBusy = (on: boolean): void => {
    busy = on;
    submit.setAttribute("aria-busy", String(on));
    label.textContent = on ? S.sending : S.cta;
    comment.disabled = on;
    for (const b of groups.flatMap((g) => [...g.querySelectorAll<HTMLButtonElement>(".starbtn")])) b.disabled = on;
    sync();
  };
  submit.addEventListener("click", async () => {
    if (busy || !token || submit.disabled) return;
    errBox.hidden = true;
    setBusy(true);
    const ts = await turnstileToken("form");
    if (ts === null) {
      $("#rv-error-text").textContent = S.errTurnstile;
      errBox.hidden = false;
      widgets.form?.reset();
      return setBusy(false);
    }
    const text = comment.value.trim().slice(0, max);
    const r = await submitReview(api, token, {
      turnstileToken: ts ?? null,
      // One comment per visit: it rides on the first service (the same text on every review of one visit would read as spam on the profile).
      items: groups.map((g, i) => ({ bookingId: g.dataset.id ?? "", rating: Number(g.dataset.v), comment: i === 0 && text ? text : null })),
    });
    if (r.ok) {
      scrub();
      return show("success");
    }
    setBusy(false);
    widgets.form?.reset(); // a Turnstile token is single use
    // 404: spent or expired meanwhile (the neutral page); 409: a booking of the visit was already reviewed.
    if (r.fail === "not-found") {
      scrub();
      return show("invalid");
    }
    if (r.fail === "conflict") {
      scrub();
      return show("already");
    }
    $("#rv-error-text").textContent = failText(r.fail);
    errBox.hidden = false;
    errBox.scrollIntoView({ block: "center" });
  });

  // ---- opt-out
  const yes = $<HTMLButtonElement>("#rv-optout-yes");
  const yesLabel = $<HTMLElement>(".lbl", yes);
  const yesText = yesLabel.textContent ?? "";
  $("#rv-optout").addEventListener("click", () => {
    $("#rv-optout-error").hidden = true;
    show("optout-confirm");
    void ensure("optout");
  });
  $("#rv-optout-back").addEventListener("click", () => show("form"));
  yes.addEventListener("click", async () => {
    if (yes.disabled || !token) return;
    yes.disabled = true;
    yes.setAttribute("aria-busy", "true");
    yesLabel.textContent = S.sending;
    $("#rv-optout-error").hidden = true;
    const ts = await turnstileToken("optout");
    const r = ts === null ? null : await optOutReviews(api, token, ts ?? null);
    yes.disabled = false;
    yes.removeAttribute("aria-busy");
    yesLabel.textContent = yesText;
    if (r?.ok) {
      scrub();
      return show("optout-done");
    }
    widgets.optout?.reset();
    if (r && !r.ok && r.fail === "not-found") {
      scrub();
      return show("invalid");
    }
    $("#rv-optout-error .t-fb").textContent = ts === null ? S.errTurnstile : r && !r.ok && r.fail === "rate-limited" ? S.errLimit : S.optoutErr;
    $("#rv-optout-error").hidden = false;
  });
}
