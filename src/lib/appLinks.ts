// Shared constants for the email-link fallback pages (phase 004).
// Public config only. Override the API origin per build with PUBLIC_API_BASE_URL (a staging or local stub API);
// the default is the production API, so no Cloudflare build variable is needed.
export const API_BASE = (import.meta.env.PUBLIC_API_BASE_URL ?? "https://api.beautica.app").replace(/\/+$/, "");

// Android applicationId used by the "open in app" intent. TODO(owner): replace with the prod applicationId once the Play
// listing exists (mobile 408). Without a fallback URL Chrome sends the user to this package's Play listing when it is not installed.
export const APP_PACKAGE = "com.beautica.beautica_mobile";

/** intent:// URL that opens the https link in the installed app (Android Chrome). */
export function androidIntent(pathAndQuery: string): string {
  return `intent://beautica.app${pathAndQuery}#Intent;scheme=https;package=${APP_PACKAGE};end`;
}
