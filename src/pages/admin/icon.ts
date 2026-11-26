// W049: POST /admin/icon = a category-icon upload (multipart), validated and forwarded by src/lib/admin/icons.ts, then 303 back to the admin page it came from.
// The Access-JWT gate already ran in src/middleware.ts; requireActor re-checks it (the shared pattern of every admin route). No other method is served.
import type { APIRoute } from "astro";
import { notFound, requireActor } from "../../lib/admin/access.ts";
import { adminConfig } from "../../lib/admin/runtime.ts";
import { uploadIcon } from "../../lib/admin/icons.ts";

export const prerender = false;

export const ALL: APIRoute = async ({ request, locals }) => {
  const actor = requireActor(locals);
  if (actor instanceof Response) return actor;
  const cfg = adminConfig();
  if (!cfg) return notFound();
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
  const d = await uploadIcon(cfg, actor, request);
  return new Response(null, { status: 303, headers: { Location: d.location, "Cache-Control": "no-store" } }); // relative Location: works on prod and staging origins alike
};
