// Backend 407 Telegram reminder-channel calls (status / link-token / unlink). Own module: the guest cancel page loads only this and http.ts.
import { call, post, obj, type Result } from "./http.ts";

/** Backend 407: the only shape a deep link may have (a bot username and a start token). Anything else is never followed. */
export const TELEGRAM_URL = /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\?start=[A-Za-z0-9_-]{1,64}$/;

export type LinkToken = { alreadyLinked: true } | { alreadyLinked: false; url: string };

/** POST /api/v1/book/telegram/link-token (404 = not eligible / feature off). Body: the cancel token only. */
export function telegramLinkToken(api: string, token: string): Promise<Result<LinkToken>> {
  return call(`${api}/api/v1/book/telegram/link-token`, post({ cancelToken: token }), (j) => {
    const o = obj(j);
    if (o.alreadyLinked === true) return { alreadyLinked: true };
    return typeof o.url === "string" && TELEGRAM_URL.test(o.url) ? { alreadyLinked: false, url: o.url } : null;
  });
}

/** POST /api/v1/book/telegram/status. */
export function telegramStatus(api: string, token: string): Promise<Result<{ available: boolean; linked: boolean; offerChoice: boolean }>> {
  return call(`${api}/api/v1/book/telegram/status`, post({ cancelToken: token }), (j) => {
    const o = obj(j);
    return typeof o.available === "boolean" && typeof o.linked === "boolean" ? { available: o.available, linked: o.linked, offerChoice: o.offerChoice === true } : null;
  });
}

/** POST /api/v1/book/telegram/unlink (204, idempotent): the phone goes back to SMS. */
export function telegramUnlink(api: string, token: string): Promise<Result<true>> {
  return call(`${api}/api/v1/book/telegram/unlink`, post({ cancelToken: token }), () => true);
}
