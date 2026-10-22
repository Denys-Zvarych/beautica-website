// Guest cancel link /book/cancel/{token} (phase 004 shell, src/pages/l/cancel.astro) served by the Worker so the page uses the SAME
// runtime API_ORIGIN as the link pages: the static shell is fetched from the asset layer, its `data-api` and the CSP connect-src are
// set for the environment (local / staging / prod). Headers of the shell (no-referrer, no-store, noindex) come from public/_headers.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { bookingConfig } from "../../../lib/booking/config";
import { CSP } from "../../../lib/securityHeaders";

export const prerender = false;

const PROD_API = "https://api.beautica.app";

export const GET: APIRoute = async ({ request }) => {
  const cfg = bookingConfig();
  const assets = (env as unknown as { ASSETS: { fetch(r: Request): Promise<Response> } }).ASSETS;
  const shell = await assets.fetch(new Request(new URL("/l/cancel", request.url)));
  if (!shell.ok) return shell;
  const html = (await shell.text()).replace(/(id="cancel-root"[^>]*?\sdata-api=")[^"]*(")/, `$1${cfg.apiOrigin}$2`);
  const headers = new Headers(shell.headers);
  for (const h of ["content-length", "content-encoding", "etag"]) headers.delete(h);
  headers.set("Content-Security-Policy", CSP.replace(PROD_API, cfg.apiOrigin));
  return new Response(html, { status: 200, headers });
};
