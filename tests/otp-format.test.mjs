// Phase 029: which OTP SMS format a browser gets (PLAIN only on iOS outside confirmed Safari) and which browsers are in-app WebViews.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectOtpSmsFormat, isInAppBrowser } from "../src/scripts/booking/otp-format.ts";

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko)";
const safari = `${IOS} Version/17.5 Mobile/15E148 Safari/604.1`;

// [name, ua, maxTouchPoints, telegramProxy, expected format, in-app]
const rows = [
  ["iOS Safari", safari, 5, false, "DOMAIN_BOUND", false],
  ["iPadOS Safari (Macintosh + touch)", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", 5, false, "DOMAIN_BOUND", false],
  ["macOS Safari (no touch)", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", 0, false, "DOMAIN_BOUND", false],
  ["iOS Instagram", `${IOS} Mobile/15E148 Instagram 330.0.0.34.116 (iPhone14,5; iOS 17_5; uk_UA; uk; scale=3.00; 1170x2532; 570000000)`, 5, false, "PLAIN", true],
  ["iOS Facebook (FBAN/FBAV)", `${IOS} Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.38.108;FBBV/565000000;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/uk_UA]`, 5, false, "PLAIN", true],
  ["iOS Messenger", `${IOS} Mobile/15E148 [FBAN/MessengerForiOS;FBAV/450.0.0.38.108;FBSS/3]`, 5, false, "PLAIN", true],
  ["iOS TikTok", `${IOS} Mobile/15E148 musical_ly_33.0.0 BytedanceWebview/d8a21c6 TikTok`, 5, false, "PLAIN", true],
  ["iOS Viber", `${IOS} Mobile/15E148 Viber/21.0`, 5, false, "PLAIN", true],
  ["iOS WhatsApp", `${IOS} Mobile/15E148 WhatsApp/24.10.80`, 5, false, "PLAIN", true],
  ["iOS Line", `${IOS} Mobile/15E148 Safari Line/14.8.0`, 5, false, "PLAIN", true],
  ["iOS Gmail / Google app (GSA)", `${IOS} Version/17.5 Mobile/15E148 Safari/604.1 GSA/320.0.0`, 5, false, "PLAIN", true],
  ["iOS Telegram UA", `${IOS} Mobile/15E148 Telegram-iOS`, 5, false, "PLAIN", true],
  ["iOS Telegram via proxy, Safari-like UA", safari, 5, true, "PLAIN", true],
  ["iOS Chrome (CriOS)", `${IOS} CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1`, 5, false, "PLAIN", false],
  ["iOS Firefox (FxiOS)", `${IOS} FxiOS/126.0 Mobile/15E148 Safari/605.1.15`, 5, false, "PLAIN", false],
  ["iOS Edge (EdgiOS)", `${IOS} Version/17.0 EdgiOS/125.0.2535.60 Mobile/15E148 Safari/605.1.15`, 5, false, "PLAIN", false],
  ["iOS Opera (OPiOS)", `${IOS} Version/17.0 OPiOS/16.0.15 Mobile/15E148 Safari/9537.53`, 5, false, "PLAIN", false],
  ["bare WKWebView (no Safari/)", `${IOS} Mobile/15E148`, 5, false, "PLAIN", false],
  ["Android Chrome", `${ANDROID} Chrome/125.0.6422.165 Mobile Safari/537.36`, 5, false, "DOMAIN_BOUND", false],
  ["Android Samsung Internet", `${ANDROID} SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36`, 5, false, "DOMAIN_BOUND", false],
  ["Android Firefox", "Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0", 5, false, "DOMAIN_BOUND", false],
  ["Android Instagram WebView", `${ANDROID} Chrome/125.0.6422.165 Mobile Safari/537.36 Instagram 330.0.0.38.92 Android (34/14; 420dpi)`, 5, false, "DOMAIN_BOUND", true],
  ["Android Facebook WebView", `${ANDROID} Chrome/125.0.6422.165 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.38.108;]`, 5, false, "DOMAIN_BOUND", true],
  ["empty UA", "", 0, false, "DOMAIN_BOUND", false],
];

describe("detectOtpSmsFormat / isInAppBrowser", () => {
  for (const [name, ua, maxTouchPoints, hasTelegramProxy, format, inApp] of rows) {
    test(name, () => {
      const env = { ua, maxTouchPoints, hasTelegramProxy };
      assert.equal(detectOtpSmsFormat(env), format);
      assert.equal(isInAppBrowser(env), inApp);
    });
  }
  test("the Telegram proxy alone is enough for an in-app verdict, on Android it stays DOMAIN_BOUND", () => {
    const env = { ua: `${ANDROID} Chrome/125.0 Mobile Safari/537.36`, maxTouchPoints: 5, hasTelegramProxy: true };
    assert.equal(isInAppBrowser(env), true);
    assert.equal(detectOtpSmsFormat(env), "DOMAIN_BOUND");
  });
});
