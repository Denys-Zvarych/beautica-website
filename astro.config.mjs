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
  build: { format: "file" },
  adapter: cloudflare({ imageService: "compile" }),
  integrations: [
    sitemap({
      // 404 and (later) token routes must never reach the sitemap.
      filter: (page) => !/\/404$/.test(page),
    }),
  ],
  i18n: {
    defaultLocale: "uk",
    locales: ["uk"],
    routing: { prefixDefaultLocale: false },
  },
});
