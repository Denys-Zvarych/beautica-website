# beautica-build-alerts

Queue consumer that emails the operator when a Workers Build of `beautica-site` fails or is cancelled (spec WEB-72, phase 053).
Separate Worker, inert for the site build (the site reads only the root `wrangler.jsonc`). Deployed by hand, never by Workers Builds.

Deploy (from `beautica-website/`): `npx wrangler deploy -c ops/build-alerts/wrangler.jsonc`

Owner steps O1-O5 (queue `beautica-build-events`, deploy, event subscription for `build.failed` + `build.canceled`, cancel test, link check):
`docs/website-phases/phase-053-build-failure-email-alerts.md`.

Test: `node --test tests/build-alerts.test.mjs`
