// Runs for on-demand (Worker) routes only; prerendered pages are served as assets and get public/_headers instead.
// Replaces Astro's built-in checkOrigin (disabled in astro.config.mjs): that check answers 403 before user middleware,
// so the rejection would carry no security / no-store / noindex headers.
import { defineMiddleware } from "astro:middleware";
import { withSecurityHeaders } from "./lib/securityHeaders";

const FORM_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"];

export const onRequest = defineMiddleware(async (ctx, next) => {
  const { request } = ctx;
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const origin = request.headers.get("origin");
    // Browser form posts only; non-browser clients (no Origin) and JSON fetches are left to the route.
    if (FORM_TYPES.includes(type) && origin && origin !== new URL(request.url).origin) {
      return withSecurityHeaders(
        new Response("Cross-site POST form submissions are forbidden", {
          status: 403,
          headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
        }),
      );
    }
  }
  return withSecurityHeaders(await next());
});
