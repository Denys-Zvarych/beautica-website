// Runs for on-demand (Worker) routes only; prerendered pages are served as assets and get public/_headers instead.
// Replaces Astro's built-in checkOrigin (disabled in astro.config.mjs): that check answers 403 before user middleware,
// so the rejection would carry no security / no-store / noindex headers.
import { defineMiddleware } from "astro:middleware";
import { withSecurityHeaders } from "./lib/securityHeaders";

/** SSR link pages: /book/{slug} and /book/s/{slug} (never /book/cancel/{token}: two segments, static shell). */
const LINK_PAGE = /^\/book\/(?:s\/)?[^/]+$/;

const FORM_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"];

export const onRequest = defineMiddleware(async (ctx, next) => {
  try {
    return await guard(ctx, next);
  } catch (err) {
    const e = err as { name?: string; message?: string; stack?: string } | undefined;
    console.error("middleware: unexpected", e?.name, e?.message, e?.stack);
    return withSecurityHeaders(
      new Response("Internal Server Error", { status: 500, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } }),
    );
  }
});

async function guard(ctx: Parameters<Parameters<typeof defineMiddleware>[0]>[0], next: Parameters<Parameters<typeof defineMiddleware>[0]>[1]) {
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
  if (request.method === "GET" && LINK_PAGE.test(new URL(request.url).pathname)) return cachedLinkPage(ctx, next);
  return withSecurityHeaders(await next());
}

/**
 * Edge cache for the link pages (Cache API, `caches.default`): the rendered page is kept for the upstream s-maxage (the backend
 * bounds staleness at 30 s), keyed by path only, so UTM / query variants share one entry and the backend sees at most one render
 * per slug per window per data centre. Only 200 indexable pages are stored; notices, 404 and 5xx never. The Cache API runs on a
 * custom domain only (not *.workers.dev): previews always miss, by design. `X-Beautica-Cache` shows HIT / MISS.
 */
async function cachedLinkPage(ctx: Parameters<Parameters<typeof defineMiddleware>[0]>[0], next: Parameters<Parameters<typeof defineMiddleware>[0]>[1]) {
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  const url = new URL(ctx.request.url);
  const key = new Request(`${url.origin}${url.pathname}`, { method: "GET" });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      const out = new Response(hit.body, hit);
      const ttl = out.headers.get("X-Beautica-Ttl") ?? "30";
      out.headers.delete("X-Beautica-Ttl");
      out.headers.set("Cache-Control", `public, max-age=0, s-maxage=${ttl}`);
      out.headers.set("X-Beautica-Cache", "HIT");
      return out;
    }
  }
  const res = withSecurityHeaders(await next());
  res.headers.set("X-Beautica-Cache", "MISS");
  const ttl = Number(/s-maxage=(\d+)/.exec(res.headers.get("Cache-Control") ?? "")?.[1] ?? 0);
  if (cache && res.status === 200 && ttl > 0 && !res.headers.has("X-Robots-Tag") && !res.headers.has("Set-Cookie")) {
    const stored = new Response(res.clone().body, res);
    stored.headers.set("Cache-Control", `public, max-age=${ttl}`); // the Cache API stores by max-age; browsers get the original header
    stored.headers.set("X-Beautica-Ttl", String(ttl));
    stored.headers.delete("X-Beautica-Cache");
    const put = cache.put(key, stored).catch(() => undefined);
    (ctx.locals as { cfContext?: { waitUntil(p: Promise<unknown>): void } }).cfContext?.waitUntil(put);
  }
  return res;
}
