// Anything under /book/cancel/ that is not exactly /book/cancel/{token} (e.g. /book/cancel/{token}/extra). Without a route of its own the
// Worker answered these with the asset layer's plain 404 page, which skipped the middleware: shared CSP (analytics origins) and the default
// referrer policy on a URL that may hold a token. This route serves the same 404 page through the middleware, which applies the token-route
// headers (TOKEN_CSP, no-referrer, no-store, noindex; src/lib/securityHeaders.ts). The page's loader also refuses to inject analytics here.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const prerender = false;

export const ALL: APIRoute = async ({ request }) => {
  const assets = (env as unknown as { ASSETS: { fetch(r: Request): Promise<Response> } }).ASSETS;
  const page = await assets.fetch(new Request(new URL("/404", request.url)));
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  return new Response(request.method === "HEAD" ? null : await page.text(), { status: 404, headers });
};
