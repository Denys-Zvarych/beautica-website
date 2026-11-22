# beautica-website

Marketing, legal and booking-link site for Beautica — <https://beautica.app>. Ukrainian only (EN-ready).
Astro 7 (static) + `@astrojs/cloudflare`, hosted as a Cloudflare Worker with static assets (Workers Builds, Worker `beautica-site`).
Plan and decisions: `docs/website-phases/` in the monorepo (README = decisions, `phase-NNN-*.md` = checklists).

## Commands (Node 24, see `.nvmrc`)

```bash
npm ci
npm run dev                          # dev server
npm run build                        # -> dist/client (static site) + Worker config for wrangler
npx wrangler deploy --dry-run        # after a build: proves wrangler.jsonc + assets
npm run check                        # astro check (TypeScript)
node scripts/check-tokens.mjs        # token parity vs ../beautica-mobile (mandatory before every PR)
node scripts/check-responsive.mjs    # 320/360/768/1280 px: no h-scroll, taps >= 48 px (needs Chromium, set CHROMIUM_PATH)
npx html-validate 'dist/client/**/*.html'
lychee --offline --include-fragments --fallback-extensions html --root-dir "$PWD/dist/client" 'dist/client/**/*.html'   # lychee 0.24.2 (GitHub release, sha256-verified)
```

Design tokens live in `src/styles/tokens.css`, derived 1:1 from `beautica-mobile/lib/core/theme/*.dart`; every
line carries `/* @src Dart.Symbol */`. Never edit values by hand without changing the app first.
`src/styles/fonts.css` is hand-written (variable WOFF2 from `@fontsource-variable/*`). Icons/OG image: `node scripts/generate-assets.mjs`.

## Release gate: no `TODO(owner)` placeholders

The legal pages render the operator name and details from `src/config/legal.mjs` (`OPERATOR_NAME`, `OPERATOR_DETAILS`), which are
`TODO(owner)` until the Play Console developer exists. `node scripts/check-no-todo-owner.mjs` (after `npm run build`) fails when
`TODO(owner)` is left in `LEGAL_VARS` or anywhere in `dist/`. CI runs it only for PRs whose base is `main`, so `dev` PRs stay green
and a release with the placeholder cannot merge. To release: fill the two constants, rebuild, run the script.

## Promotion guard (advisory)

`.github/workflows/promotion-source.yml` (ported from beautica-mobile) runs on `pull_request_target` and shows a red X when a PR
into `main` is not from `dev` / `hotfix/*` of this repo, or a PR into `dev` is from `main` without a `sync:` title.
The repo is private on GitHub Free: no rulesets, so it only warns until Pro. It takes effect once it is on `main`
(GitHub runs `pull_request_target` from the default branch). `scripts/forbid_pull_request_target_outside_promotion.sh` (a CI step)
pins its SHA-256: any edit to the workflow must update `EXPECTED_SHA256` in the same PR. `.github/CODEOWNERS` owns `/.github/`.

## Overrides (`package.json`)

- `sharp` -> `0.35.5`: one patched sharp for Astro's image pipeline and our asset script.
- `miniflare` -> `undici 7.30.1`: the pinned `wrangler@4.142.0` pulls `miniflare` which pins `undici@7.29.0`
  (high-severity advisories), and CI runs `npm audit --omit=dev --audit-level=high`. **Remove this override when
  wrangler / `@astrojs/cloudflare` are bumped to a version whose miniflare depends on `undici >= 7.30.1`**
  (check with `npm ls undici` and `npm audit --omit=dev`).

## Git flow

Feature branch from `dev` -> PR to `dev` -> release PR `dev` -> `main`. Never push `main` / `dev` directly.
CI (`.github/workflows/ci.yml`) runs on PRs: dependency audit, build, lychee (offline), html-validate, token parity, Lighthouse budget.
Cloudflare deploys; CI never does.

## Owner checklist: Cloudflare Worker + domain (one-time, manual, phase 001)

Hosting is a Cloudflare Worker with static assets (`wrangler.jsonc`), built by Workers Builds. Do these in order.
Nothing here touches the mobile or backend repos.

1. `dig MX beautica.app +short` and `dig TXT beautica.app +short`: save the output (it must be identical at the end).
2. Dashboard -> Workers & Pages -> Create -> **Import a repository** -> GitHub `beautica-website`
   (grant the Cloudflare GitHub app access to this private repo).
   - Project / Worker name: `beautica-site` (must equal `name` in `wrangler.jsonc`)
   - Production branch: `main`
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
   - **Non-production branch builds: ON**, preview command `npx wrangler versions upload`
   - Build variable: `NODE_VERSION` = `22`
3. Open `beautica-site.<account-subdomain>.workers.dev`: the placeholder renders, and an unknown path shows the custom 404 with HTTP 404.
   Push `dev`: the Previews tab / PR comment shows `dev-beautica-site.<account-subdomain>.workers.dev`.
4. Old Pages project `beautica` -> Custom domains -> remove `beautica.app` (and `www` if present). This deletes its apex CNAME.
5. Worker `beautica-site` -> Settings -> Domains & Routes -> Add -> Custom Domain `beautica.app`, then `www.beautica.app`.
   Wait for "Active" (certificate issued). Downtime is about 1-2 minutes. Do **not** edit MX / TXT / email-routing records.
6. Rules -> Redirect Rules -> template "Redirect from WWW to root": 301, preserve path + query.
   Check: `http://beautica.app` and `https://www.beautica.app/x` both 301 to `https://beautica.app/...`; `https://beautica.app/x/` 301s to `/x`.
7. Re-run step 1: the output must be identical. Send test mails to `support@`, `privacy@`, `admin@beautica.app`; all three must arrive.
8. Delete the old Pages project `beautica` only after steps 3-7 pass.
9. GitHub: branch protection is not enforceable on a private Free repo; follow the PR flow by convention.

Local proof of the deploy config: `npm run build && npx wrangler deploy --dry-run` (uses the config the adapter writes to `dist/client/wrangler.json`
via `.wrangler/deploy/config.json`; `.assetsignore` keeps it out of the public assets).

## Owner checklist: search engines (manual, DNS TXT only)

1. Google Search Console -> Add property -> **Domain** `beautica.app` -> copy the TXT record.
2. Bing Webmaster Tools -> Add site -> verify by DNS (CNAME/TXT as offered; prefer TXT) or import from GSC.
3. Add each TXT record in Cloudflare DNS (TXT only; no other record changes). Click Verify in both consoles.
4. Do **not** submit the sitemap yet (done at launch gate G1).

## CI note

Token parity checks out `Denys-Zvarych/beautica-mobile` (branch `dev`, `lib/core/theme` only). That works while the mobile repo is public.
When it goes private the checkout step fails softly and CI prints a warning (parity is then not verified in CI; run the check locally).

## Admin (`/admin*`, phase 039): owner setup per environment

Private operator area. Cloudflare Access at the edge plus a Worker-side Access-JWT check (anything else: 404). The Worker calls only
`/api/v1/internal/catalog/**` with the catalog-scoped key (secret, never sent to the browser). Missing value = `/admin` disabled (404).
The check is IdP-independent (Google, one-time PIN...): only the signed claims (`aud`, `iss`, `exp`, `email`) count.

| | Prod (`https://beautica.app`) | Staging (`https://dev-beautica-site.beautica-ua.workers.dev`) |
|---|---|---|
| Access app (Zero Trust > Access > Applications > Self-hosted) | domain `beautica.app`, path `admin` (also `admin/*`), policy Allow: email = owner, session 24 h | domain `dev-beautica-site.beautica-ua.workers.dev`, path `admin`, same policy; own AUD |
| `CF_ACCESS_TEAM_DOMAIN` (var) | `beautica.cloudflareaccess.com` (in `wrangler.jsonc` `vars`) | same (in `previews.vars`) |
| `CF_ACCESS_AUD` (var) | prod app's Application Audience (AUD) tag | staging app's AUD tag (differs) |
| `ADMIN_EMAILS` (var) | owner email(s), comma-separated | same |
| `INTERNAL_CATALOG_KEY` (secret) | = backend prod `INTERNAL_CATALOG_KEY` | = backend staging `INTERNAL_CATALOG_KEY` |
| `API_ORIGIN` (var, exists) | `https://api.beautica.app` | staging Railway API (already in `previews.vars`) |

Vars/secrets go in the dashboard (Workers > beautica-site > Settings > Variables and Secrets; staging = the preview environment) or
`wrangler secret put INTERNAL_CATALOG_KEY`; `keep_vars` keeps them across deploys. Other preview URLs have no Access app: `/admin` returns 404 there.

Render the authenticated shell (test-only harness, no bypass in `src/`; it serves a throwaway JWKS to a temp copy of `dist/`):

```bash
npm run build
node scripts/render-admin.mjs --out /tmp/admin.html            # HTML of /admin as the owner (exit 0 on 200); then html-validate / axe on the file
node scripts/render-admin.mjs --serve 4399                     # http://127.0.0.1:4399/admin for screenshots at 360/768/1280 and axe (Ctrl-C to stop)
```

Checks on `/admin` (all through the harness; `npm run build` first):

```bash
npm run check:admin                                   # harness + check-responsive --base + check-axe + Lighthouse (scripts/lighthouserc-admin.json); wired into the CI `lighthouse` job
node scripts/render-admin.mjs --serve 4399            # in one shell, then in another:
node scripts/check-responsive.mjs --base http://127.0.0.1:4399 --routes /admin
node scripts/check-axe.mjs http://127.0.0.1:4399/admin   # Playwright + axe-core (any URL; replaces @axe-core/cli, whose chromedriver does not run here)
```

`/admin` uses the small Latin font subsets of the legal pages (~83 KB of fonts instead of ~109 KB). `INTERNAL_CATALOG_KEY` must be >= 32 characters and `API_ORIGIN` must be a valid https origin (no prod fallback), else `/admin` is disabled (404).
