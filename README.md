# beautica-website

Marketing, legal and booking-link site for Beautica — <https://beautica.app>. Ukrainian only (EN-ready).
Astro 6 (static) + `@astrojs/cloudflare`, hosted on Cloudflare Pages (project `beautica-site`).
Plan and decisions: `docs/website-phases/` in the monorepo (README = decisions, `phase-NNN-*.md` = checklists).

## Commands (Node 22, see `.nvmrc`)

```bash
npm ci
npm run dev                          # dev server
npm run build                        # -> dist/client (static site)
npm run check                        # astro check (TypeScript)
node scripts/check-tokens.mjs        # token parity vs ../beautica-mobile (mandatory before every PR)
node scripts/check-responsive.mjs    # 320/360/768/1280 px: no h-scroll, taps >= 48 px (needs Chromium, set CHROMIUM_PATH)
npx html-validate 'dist/client/**/*.html'
```

Design tokens live in `src/styles/tokens.css`, derived 1:1 from `beautica-mobile/lib/core/theme/*.dart`; every
line carries `/* @src Dart.Symbol */`. Never edit values by hand without changing the app first.
`src/styles/fonts.css` is generated: `node scripts/generate-fonts-css.mjs`. Icons/OG image: `node scripts/generate-assets.mjs`.

## Git flow

Feature branch from `dev` -> PR to `dev` -> release PR `dev` -> `main`. Never push `main` / `dev` directly.
CI (`.github/workflows/ci.yml`) runs on PRs: build, lychee (offline), html-validate, token parity, Lighthouse budget.
Cloudflare deploys; CI never does.

## Owner checklist: Cloudflare Pages + domain (one-time, manual, phase 001)

Do these in order. Nothing here touches the mobile or backend repos.

1. **Record mail DNS first.** `dig MX beautica.app +short` and save the output (must be identical at the end).
2. **Create the Pages project.** Cloudflare dashboard -> Workers & Pages -> Create -> Pages -> Connect to Git ->
   `Denys-Zvarych/beautica-website` (grant the Cloudflare GitHub app access to this private repo).
   - Project name: `beautica-site`
   - Production branch: `main`
   - Framework preset: Astro (or None), build command `npm run build`
   - **Build output directory: `dist/client`** (the Cloudflare adapter writes the static site there, not `dist`)
   - Environment variable: `NODE_VERSION` = `22`
   - Preview deployments: all branches (so `dev` and PR branches get preview URLs; stable alias `dev.beautica-site.pages.dev`)
3. **Verify** the first build on `https://beautica-site.pages.dev` (placeholder page, `/nope` shows the custom 404 with HTTP 404).
4. **Move the custom domain.** Old `beautica` Pages project -> Custom domains -> remove `beautica.app`.
   New `beautica-site` -> Custom domains -> add `beautica.app` (Cloudflare adjusts the apex record automatically).
   Do **not** edit MX / TXT / email-routing records.
5. **www redirect.** Add `www` as a custom domain of `beautica-site` or a Redirect Rule `www.beautica.app/*` -> `https://beautica.app/${1}` (301).
   Check: `http://beautica.app` and `https://www.beautica.app/x` both 301 to `https://beautica.app/...`; `https://beautica.app/x/` 301 to `/x`
   (Pages does this for extension-less routes; report if it does not).
6. **Re-run `dig MX beautica.app +short`** and compare with step 1. Send a test mail to `support@`, `privacy@`, `admin@beautica.app`; all three must arrive.
7. **Delete the old `beautica` Pages project** only after steps 3-6 pass.
8. **GitHub:** Settings -> Branches is not enforceable on a private Free repo; follow the PR flow by convention.
   Optionally add a repo secret if the mobile repo is made private (see CI note below).

## Owner checklist: search engines (manual, DNS TXT only)

1. Google Search Console -> Add property -> **Domain** `beautica.app` -> copy the TXT record.
2. Bing Webmaster Tools -> Add site -> verify by DNS (CNAME/TXT as offered; prefer TXT) or import from GSC.
3. Add each TXT record in Cloudflare DNS (TXT only; no other record changes). Click Verify in both consoles.
4. Do **not** submit the sitemap yet (done at launch gate G1).

## CI note

Token parity checks out `Denys-Zvarych/beautica-mobile` (branch `dev`, `lib/core/theme` only). That works while the mobile repo is public.
When it goes private the checkout step fails softly and CI prints a warning (parity is then not verified in CI; run the check locally).
