// Phase 029: which OTP SMS text the guest gets. iOS QuickType offers a code from a plain one-line SMS in in-app browsers / non-Safari
// browsers; Safari (and Android WebOTP) use the domain-bound text. All UA regexes live here only (tokens drift with app releases).
export type OtpSmsFormat = "PLAIN" | "DOMAIN_BOUND";
export interface OtpEnv {
  ua: string;
  maxTouchPoints: number;
  hasTelegramProxy: boolean;
}

const IN_APP = /Instagram|FBAN|FBAV|FB_IAB|FBIOS|FBSS|Messenger|musical_ly|BytedanceWebview|TikTok|Trill|Line\/|Snapchat|Viber|WhatsApp|GSA\/|Telegram/;
const OTHER_IOS_BROWSER = /CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|DuckDuckGo/;

const isIOS = (e: OtpEnv): boolean => /iPhone|iPad|iPod/.test(e.ua) || (e.ua.includes("Macintosh") && e.maxTouchPoints > 1);

/** A social / messenger app's own WebView (iOS or Android). */
export function isInAppBrowser(e: OtpEnv): boolean {
  return IN_APP.test(e.ua) || e.hasTelegramProxy;
}

/** PLAIN iff iOS and not confirmed Safari; DOMAIN_BOUND otherwise (all Android, desktop, empty UA). When unsure on iOS: PLAIN. */
export function detectOtpSmsFormat(e: OtpEnv): OtpSmsFormat {
  if (!isIOS(e)) return "DOMAIN_BOUND";
  const looksLikeSafari = e.ua.includes("Safari/") && e.ua.includes("Version/");
  return isInAppBrowser(e) || OTHER_IOS_BROWSER.test(e.ua) || !looksLikeSafari ? "PLAIN" : "DOMAIN_BOUND";
}

export function currentEnv(): OtpEnv {
  return { ua: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints || 0, hasTelegramProxy: "TelegramWebviewProxy" in window };
}
