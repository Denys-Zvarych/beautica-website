// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import sitemap from "@astrojs/sitemap";

// Static by default, deployed as a Cloudflare Worker with static assets (wrangler.jsonc, Workers Builds).
// SSR routes (/book/{slug}, phase 008) only need `export const prerender = false`.
export default defineConfig({
  site: "https://beautica.app",
  output: "static",
  trailingSlash: "never",
  // Static site, no Astro sessions: without this the Cloudflare adapter adds an id-less SESSION KV binding
  // that makes `wrangler preview` / Workers Builds fail with code 10021.
  session: false,
  // Astro's built-in origin check answers 403 before user middleware (no security/no-store headers); src/middleware.ts
  // does the same check and adds the headers.
  security: { checkOrigin: false },
  build: { format: "file", inlineStylesheets: "always" },
  // Never inline module scripts into the HTML (CSP: no inline scripts, README D8); they ship as /_astro/*.js.
  vite: { build: { assetsInlineLimit: 0 } },
  adapter: cloudflare({ imageService: "compile" }),
  integrations: [
    sitemap({
      // 404, the token-route shells (/l/*) and the wizard fragment (/book-steps/*) must never reach the sitemap.
      filter: (page) => !/\/404$/.test(page) && !/\/l\//.test(page) && !/\/book-steps\//.test(page) && !/\/admin(\/|$)/.test(page),
    }),
  ],
  i18n: {
    defaultLocale: "uk",
    locales: ["uk"],
    routing: { prefixDefaultLocale: false },
  },
});
