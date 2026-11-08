// Guest cancel link /book/cancel/{token} (phase 004 shell, src/pages/l/cancel.astro) served by the Worker so the page uses the SAME
// runtime API_ORIGIN as the link pages: the static shell is fetched from the asset layer, its `data-api` and the CSP connect-src are
// set for the environment (local / staging / prod). Headers of the shell (no-referrer, no-store, noindex) come from public/_headers.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { bookingConfig } from "../../../lib/booking/config";
import { isValidCancelToken } from "../../../lib/guestCancel";
import { TOKEN_CSP } from "../../../lib/securityHeaders";

export const prerender = false;

const PROD_API = "https://api.beautica.app";

const assets404 = (request: Request) =>
  (env as unknown as { ASSETS: { fetch(r: Request): Promise<Response> } }).ASSETS.fetch(new Request(new URL("/404", request.url)));

export const GET: APIRoute = async ({ request, params }) => {
  // Invalid token: the same 404 as [...rest].ts (served through the middleware, which adds the token-route headers).
  if (!isValidCancelToken(params.token)) {
    const nf = await assets404(request);
    return new Response(request.method === "HEAD" ? null : await nf.text(), { status: 404, headers: new Headers({ "Content-Type": "text/html; charset=utf-8" }) });
  }
  const cfg = bookingConfig();
  const assets = (env as unknown as { ASSETS: { fetch(r: Request): Promise<Response> } }).ASSETS;
  // Phase 032: ?n=1 (the booking's own address after it was made) gets the variant with the calendar block; every other visit the plain page (no calendar code at all).
  const confirmed = new URL(request.url).searchParams.get("n") === "1";
  const shell = await assets.fetch(new Request(new URL(confirmed ? "/l/cancel-confirmed" : "/l/cancel", request.url)));
  if (!shell.ok) return shell;
  const html = (await shell.text()).replace(/(id="cancel-root"[^>]*?\sdata-api=")[^"]*(")/, `$1${cfg.apiOrigin}$2`);
  const headers = new Headers(shell.headers);
  for (const h of ["content-length", "content-encoding", "etag"]) headers.delete(h);
  headers.set("Content-Security-Policy", TOKEN_CSP.replace(PROD_API, cfg.apiOrigin));
  return new Response(html, { status: 200, headers });
};
