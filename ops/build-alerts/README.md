# beautica-build-alerts

Queue consumer that emails the operator when a Workers Build of `beautica-site` fails or is cancelled (spec WEB-72, phase 053).
Separate Worker, inert for the site build (the site reads only the root `wrangler.jsonc`). Deployed by hand, never by Workers Builds.

Deploy: by hand in the Cloudflare dashboard (live since 2026-11-26; the owner does not use `wrangler login` on the dev machine).
After ANY change to `src/`, redeploy the same way:

1. Build one paste-able file: `src/format.mjs` with its `export` keywords removed, followed by `src/index.mjs`
   without its `import` line.
2. Workers & Pages → `beautica-build-alerts` → Edit code → replace everything with that file → Deploy.
   The editor preview shows "No fetch handler!": expected, this Worker only consumes the queue.

Dashboard config that mirrors `wrangler.jsonc` (keep both in sync):
- Binding: Email Service, variable `ALERT_MAIL`, destination `beautica.ua@gmail.com`.
- Queue `beautica-build-events` → consumer `beautica-build-alerts`: batch 10, wait 5 s, 3 retries, no dead-letter queue.
- Queue subscription `site-build-alerts`: Workers Builds, `build.failed` + `build.canceled`.

With an API token instead of a login, `npx wrangler deploy -c ops/build-alerts/wrangler.jsonc` deploys the same Worker.
Note: Cloudflare may report a cancelled build as `build.failed`, so the email can say «Збірка впала» for a cancel (accepted).

Owner steps O1-O5 and history: `docs/website-phases/phase-053-build-failure-email-alerts.md`.

Test: `node --test tests/build-alerts.test.mjs`
