// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import sitemap from "@astrojs/sitemap";

// Static by default. The adapter is installed now so SSR routes (/book/{slug}, phase 008)
// only need `export const prerender = false`, no restructuring.
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
  vite: {
    build: {
      rollupOptions: {
        // Third-party noise only: zod (an Astro dependency) ships @__PURE__ comments Rollup cannot place.
        onwarn(warning, defaultHandler) {
          if (warning.code === "INVALID_ANNOTATION" && warning.id?.includes("node_modules/zod/")) return;
          defaultHandler(warning);
        },
      },
    },
  },
  i18n: {
    defaultLocale: "uk",
    locales: ["uk"],
    routing: { prefixDefaultLocale: false },
  },
});
