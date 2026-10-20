// Worker entry: Astro's handler plus one rule for the 404 page. Unknown paths and /404 itself are answered from the static
// 404.html asset (no Astro middleware, no _headers match), so this wrapper gives them a real 404 status, X-Robots-Tag and the
// security headers. Every other response passes through untouched.
import handler from "@astrojs/cloudflare/entrypoints/server";
import { withSecurityHeaders } from "./lib/securityHeaders";

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const res = await (handler.fetch as (r: Request, e: unknown, c: ExecutionContext) => Promise<Response>)(request, env, ctx);
    if (res.status !== 404 && new URL(request.url).pathname !== "/404") return res;
    const headers = new Headers(res.headers);
    headers.set("X-Robots-Tag", "noindex, nofollow");
    return withSecurityHeaders(new Response(res.body, { status: 404, statusText: "Not Found", headers }));
  },
};
