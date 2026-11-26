// Start budget of scripts/render-admin.mjs, shared with the tests that spawn it so a hung harness fails on a derived bound, not a guessed one.
export const ATTEMPTS = 4, ATTEMPT_MS = 60_000;
/** Worst case of a start (every attempt used) plus the mock/JWKS/dist-copy setup margin. */
export const HARNESS_START_MS = ATTEMPTS * ATTEMPT_MS + 30_000;
