// Phase 022: «Куди ви хочете отримувати нагадування про запис?» on the booking success screen (SMS default / Telegram).
// The markup is src/components/book/ReminderChannelChoice.astro (hidden); this only toggles it. Backend 407: every call carries
// the booking's cancel token alone (never a phone); a 404 (not eligible / feature off) removes the block, so the screen is exactly
// the pre-Telegram one. The t.me link comes from the backend and is followed only when api.ts proves its shape. No polling: one
// status read when the tab becomes visible again after the guest left for Telegram.
import { telegramLinkToken, telegramStatus, telegramUnlink } from "./telegram-api.ts";
import type { Fail } from "./http.ts";
import type { TelegramAvailability } from "./api.ts";

export interface ReminderDeps {
  root: HTMLElement | null;
  api: string;
  /** The booking's cancel token (api.ts `cancelToken`), or null = no choice. */
  token: string | null;
  /** `telegram` of the booking response. */
  telegram: TelegramAvailability | null;
  navigate: (url: string) => void;
  track: (event: string) => void;
}

/** Whether the block is offered at all: Telegram on for this booking and we hold a cancel token. */
export const offered = (telegram: TelegramAvailability | null, token: string | null): boolean => telegram?.available === true && !!token;

/**
 * Cancel page (phase 024): the status answer decides, never the booking source. `linked` -> status + «Повернутися до SMS»;
 * `offerChoice` (a walk-in not linked yet) -> the choice; a booking-link guest who is not linked already chose on the success screen -> `null` (no block).
 */
export function availabilityFromStatus(s: { available: boolean; linked: boolean; offerChoice: boolean }): TelegramAvailability | null {
  if (!s.available) return null;
  return s.linked || s.offerChoice ? { available: true, linked: s.linked } : null;
}

/** Error key to show for a failed call; `null` = hide the whole block (404: not eligible or feature off). */
export const errorFor = (fail: Fail): "rate" | "fail" | null => (fail === "not-found" ? null : fail === "rate-limited" ? "rate" : "fail");

export function mountReminders(d: ReminderDeps): void {
  const root = d.root;
  const token = d.token;
  if (!root || !token || !offered(d.telegram, token)) return;
  const q = <T extends HTMLElement>(s: string): T => root.querySelector<T>(s)!;
  const linked = q("[data-r-linked]");
  const choice = q("[data-r-choice]");
  const errBox = q("[data-r-error]");
  const unlinkBtn = q<HTMLButtonElement>("[data-r-unlink]");
  const sms = q<HTMLInputElement>('input[value="sms"]');
  const tg = q<HTMLInputElement>('input[value="telegram"]');
  const connect = q<HTMLButtonElement>("[data-r-connect]");
  const connectGap = q("[data-r-connect-gap]");
  const radios = [sms, tg];
  let busy = false;
  let awaitingReturn = false;

  // Selecting a radio only changes the selection (WCAG 3.2.2); the explicit button is what leaves for Telegram.
  const syncConnect = (): void => {
    connect.hidden = connectGap.hidden = !tg.checked;
  };
  const showError = (key: "rate" | "fail" | "unlink" | null): void => {
    errBox.hidden = key === null;
    root.querySelectorAll<HTMLElement>("[data-r-err]").forEach((e) => (e.hidden = e.dataset.rErr !== key));
  };
  const showLinked = (): void => {
    showError(null);
    choice.hidden = true;
    linked.hidden = false;
  };
  const showChoice = (): void => {
    showError(null);
    linked.hidden = true;
    choice.hidden = false;
    sms.checked = true;
    syncConnect();
  };
  const setBusy = (on: boolean): void => {
    busy = on;
    radios.forEach((r) => (r.disabled = on));
    unlinkBtn.disabled = on;
    connect.disabled = on;
  };
  // A 404 after the block is on screen (the feature was switched off, the booking stopped being eligible): never remove it (layout shift);
  // swap to a calm static line in a box of the same height. A 404 on the very first render never gets here: the block is simply not mounted.
  const gone = (): void => {
    root.style.minHeight = `${root.offsetHeight}px`;
    linked.hidden = choice.hidden = true;
    showError(null);
    q("[data-r-unavailable]").hidden = false;
  };

  if (d.telegram?.linked) showLinked();
  else showChoice();
  root.hidden = false;

  connect.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    showError(null);
    d.track("reminder_channel_telegram_click");
    const r = await telegramLinkToken(d.api, token);
    if (r.ok && !r.data.alreadyLinked) {
      // Stay busy while the browser navigates: a second tap would burn another link-token (rate-limited). onVisible re-enables on return.
      awaitingReturn = true;
      d.navigate(r.data.url);
      return;
    }
    setBusy(false);
    if (!r.ok) {
      sms.checked = true;
      syncConnect();
      const e = errorFor(r.fail);
      return e === null ? gone() : showError(e);
    }
    showLinked();
  });

  // SMS is the default: choosing it sends nothing (the only way to switch a linked phone back is the unlink button).
  radios.forEach((r) => r.addEventListener("change", () => (showError(null), syncConnect())));

  // One status read when the guest comes back from Telegram (no polling loop, the endpoint is rate-limited).
  const onVisible = async (): Promise<void> => {
    if (!awaitingReturn || document.visibilityState !== "visible") return;
    awaitingReturn = false;
    setBusy(false);
    const r = await telegramStatus(d.api, token);
    if (r.ok && r.data.linked) showLinked();
  };
  document.addEventListener("visibilitychange", () => void onVisible());
  window.addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) void onVisible();
  });

  unlinkBtn.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    showError(null);
    d.track("reminder_channel_unlink");
    const r = await telegramUnlink(d.api, token);
    setBusy(false);
    if (r.ok) return showChoice();
    if (r.fail === "not-found") return gone();
    showError("unlink");
  });
}

/** Telegram is per phone: the first booking that has a cancel token stands for the whole visit. */
export function firstWithToken<T extends { token: string | null }>(items: readonly T[]): (T & { token: string }) | null {
  return (items.find((i) => i.token) as (T & { token: string }) | undefined) ?? null;
}
