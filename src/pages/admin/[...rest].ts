// Catch-all under /admin (phase 039): Astro does not run middleware for a path that matches no route, so an unknown /admin/x would be answered by
// the asset layer's public 404 (public CSP, cacheable, indexable). With this route every /admin/* path reaches src/middleware.ts first (the Access-JWT
// gate and the admin headers); an owner gets a plain 404 here until W040/W041 add real routes (more specific routes win over this one).
import type { APIRoute } from "astro";
import { notFound, requireActor } from "../../lib/admin/access.ts";

export const prerender = false;

// requireActor first (the shared pattern of every admin route); then a plain 404 for the owner too.
export const ALL: APIRoute = ({ locals }) => {
  const actor = requireActor(locals);
  return actor instanceof Response ? actor : notFound();
};
