// Phase 030 QA: the middleware's 500 path logs the error NAME only. Message and stack can echo the request URL, and /c/*, /book/cancel/*, /r/*, /api/ics?c= carry bearer tokens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// src/middleware.ts imports the Astro virtual module and an extensionless sibling: stub the first, add `.ts` to the second.
register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === "astro:middleware") return { url: "data:text/javascript,export const defineMiddleware = (f) => f;", shortCircuit: true };
  try { return await next(spec, ctx); } catch (e) { if (spec.startsWith(".") && !/\\.\\w+$/.test(spec)) return next(spec + ".ts", ctx); throw e; }
}`),
  import.meta.url,
);
const { onRequest } = await import("../src/middleware.ts");

test("an unexpected error answers 500 and logs the name only: no message, no stack, no token", async () => {
  const secret = "Ab3dEf7hJk9mNp2Q";
  const err = new TypeError(`boom for https://beautica.app/c/${secret}`);
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a);
  try {
    const res = await onRequest({ request: new Request(`https://beautica.app/c/${secret}`), locals: {} }, async () => {
      throw err;
    });
    assert.equal(res.status, 500);
  } finally {
    console.error = orig;
  }
  assert.equal(logged.length, 1);
  const flat = logged[0].map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
  assert.equal(flat.includes(secret) || flat.includes("boom") || /\bat \S+ \(|\.mjs:\d+/.test(flat), false, flat);
  assert.deepEqual(logged[0].slice(1), ["TypeError"]);
});
