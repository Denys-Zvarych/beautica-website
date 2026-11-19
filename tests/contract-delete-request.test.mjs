// Contract of POST /api/delete-request (src/pages/api/delete-request.ts) against `wrangler dev`: method, validation, honeypot,
// rate limit, Origin check, size cap, headers, no PII. Every test uses its own cf-connecting-ip, so none depends on run order.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { rmSync, readFileSync as readText, writeFileSync } from "node:fs";
import { BASE, ROOT, WRANGLER_LOG, freshIp, requireBase } from "./helpers/env.mjs";

requireBase();
const URL_ = `${BASE}/api/delete-request`;
const validFields = (over = {}) => ({ email: "client@example.com", phone: "", role: "client", comment: "", consent: "on", ...over });

/** POST a urlencoded form. Defaults: JSON reply wanted, fresh IP. */
async function post(fields, { ip = freshIp(), headers = {}, json = true, body } = {}) {
  const res = await fetch(URL_, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": ip,
      ...(json ? { accept: "application/json" } : {}),
      ...headers,
    },
    body: body ?? new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { res, text, json: parsed };
}

const assertHardened = (res) => {
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(res.headers.get("strict-transport-security") ?? "", /^max-age=\d+/);
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
};

/** Text of every email wrangler dev "sent" (miniflare writes them under .wrangler/tmp/email). */
function sentEmails() {
  const dir = join(ROOT, ".wrangler", "tmp", "email");
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.includes("email-text")) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
}

/** Poll a condition (no fixed sleeps): resolves true as soon as it holds, false after the deadline. */
async function until(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}
const log = () => (WRANGLER_LOG && existsSync(WRANGLER_LOG) ? readFileSync(WRANGLER_LOG, "utf8") : "");

describe("method", () => {
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    test(`${method} answers 405 with Allow: POST and hardened headers`, async () => {
      const res = await fetch(URL_, { method });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "POST");
      assertHardened(res);
    });
  }
});

describe("validation", () => {
  test("an empty form answers 422 listing the required fields, in form order", async () => {
    const { res, json } = await post({});
    assert.equal(res.status, 422);
    assert.deepEqual(json, { ok: false, error: "invalid", fields: ["email", "role", "consent"] });
    assertHardened(res);
  });

  for (const [name, over, field] of [
    ["a malformed email", { email: "not-an-email" }, "email"],
    ["an email without a dot in the domain", { email: "a@b" }, "email"],
    ["an incomplete phone", { phone: "+380 (50) 12" }, "phone"],
    ["an account identifier that is neither an email nor a UA mobile", { email: "12345" }, "email"],
    ["a non-UA number as the account identifier", { email: "+48123456789" }, "email"],
    ["an unknown role", { role: "admin" }, "role"],
    ["a comment over 1000 characters", { comment: "x".repeat(1001) }, "comment"],
    ["a missing consent", { consent: "" }, "consent"],
  ]) {
    test(`${name} answers 422 naming only "${field}"`, async () => {
      const { res, json } = await post(validFields(over));
      assert.equal(res.status, 422);
      assert.deepEqual(json, { ok: false, error: "invalid", fields: [field] });
    });
  }

  test("a body that is not a form answers 400", async () => {
    const { res, json } = await post({}, { headers: { "content-type": "application/json" }, body: '{"email":"a@b.co"}' });
    assert.equal(res.status, 400);
    assert.deepEqual(json, { ok: false, error: "invalid" });
  });

  test("the no-JS path answers 303 back to /delete-account?error=1 on invalid input and ?sent=1 on success", async () => {
    const bad = await post({}, { json: false });
    assert.equal(bad.res.status, 303);
    assert.equal(bad.res.headers.get("location"), "/delete-account?error=1");
    assertHardened(bad.res);
    const email = `nojs-${Date.now()}@example.com`;
    const ok = await post(validFields({ email }), { json: false });
    assert.equal(ok.res.status, 303);
    assert.equal(ok.res.headers.get("location"), "/delete-account?sent=1");
  });
});

describe("accepted request", () => {
  test("a valid request answers 200 {ok:true}, emails the team with the submitted fields and logs none of them", async () => {
    const marker = `qa${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const email = `${marker}@example.com`;
    const comment = `comment-${marker}`;
    const { res, json } = await post(validFields({ email, comment, phone: "0501234567", role: "master" }));
    assert.equal(res.status, 200);
    assert.deepEqual(json, { ok: true });
    assertHardened(res);
    assert.ok(await until(() => sentEmails().some((t) => t.includes(email))), "the team email was not produced");
    const mail = sentEmails().find((t) => t.includes(email));
    assert.match(mail, new RegExp(`${comment}`));
    assert.match(mail, /\+380501234567/, "phone is normalised to +380XXXXXXXXX");
    assert.ok(await until(() => log().includes("delete-request: sent")), "the status line was not logged");
    assert.equal(log().includes(marker), false, "submitted data leaked into the Worker log");
  });

  test("SUP-21: an account identified by a phone (0… or +380…) is accepted, normalised to E.164 in the team email, no Reply-To needed", async () => {
    const tail = `${Date.now()}`.slice(-7);
    const { res, json } = await post(validFields({ email: `050 ${tail.slice(0, 3)}-${tail.slice(3, 5)}-${tail.slice(5)}` }));
    assert.equal(res.status, 200);
    assert.deepEqual(json, { ok: true });
    const e164 = `+38050${tail}`;
    assert.ok(await until(() => sentEmails().some((t) => t.includes(e164))), "the team email with the E.164 account phone was not produced");
    assert.match(sentEmails().find((t) => t.includes(e164)), new RegExp(`Email або телефон акаунта: \\${e164}`));
  });

  test("a phone is normalised in the email, a missing one reads «не вказано»", async () => {
    const email = `nophone-${Date.now()}@example.com`;
    await post(validFields({ email }));
    assert.ok(await until(() => sentEmails().some((t) => t.includes(email))));
    assert.match(sentEmails().find((t) => t.includes(email)), /Телефон: не вказано/);
  });
});

describe("honeypot", () => {
  test("a filled hidden field answers 200 {ok:true} but sends nothing and logs only a status line", async () => {
    const marker = `bot${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const before = (log().match(/delete-request: honeypot/g) ?? []).length;
    const { res, json } = await post(validFields({ email: `${marker}@example.com`, website: "http://spam.example" }));
    assert.equal(res.status, 200);
    assert.deepEqual(json, { ok: true });
    assert.ok(await until(() => (log().match(/delete-request: honeypot/g) ?? []).length > before), "honeypot branch was not taken");
    assert.equal(sentEmails().some((t) => t.includes(marker)), false, "a honeypot request produced an email");
    assert.equal(log().includes(marker), false);
  });

  test("a honeypot hit wins over validation (invalid fields still read as success)", async () => {
    const { res, json } = await post({ website: "x" });
    assert.equal(res.status, 200);
    assert.deepEqual(json, { ok: true });
  });
});

describe("rate limit", () => {
  test("the 4th request within a minute from one IP answers 429, another IP is unaffected", async () => {
    const ip = freshIp();
    for (let i = 1; i <= 3; i++) assert.equal((await post({}, { ip })).res.status, 422, `request ${i} must pass the limiter`);
    const { res, json } = await post(validFields(), { ip });
    assert.equal(res.status, 429);
    assert.deepEqual(json, { ok: false, error: "rate_limited" });
    assertHardened(res);
    assert.equal((await post({}, { ip: freshIp() })).res.status, 422, "a different IP has its own bucket");
  });

  test("the no-JS path is limited too (303 back with ?error=1)", async () => {
    const ip = freshIp();
    for (let i = 0; i < 3; i++) await post({}, { ip, json: false });
    const { res } = await post(validFields(), { ip, json: false });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/delete-account?error=1");
  });
});

describe("origin", () => {
  test("a foreign Origin on a browser form post answers 403 with hardened headers (middleware)", async () => {
    const { res } = await post(validFields(), { headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assertHardened(res);
  });

  test("a foreign Origin on a JSON-accepting multipart fetch answers 403 too", async () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(validFields())) fd.set(k, v);
    const res = await fetch(URL_, { method: "POST", body: fd, headers: { origin: "https://evil.example", accept: "application/json", "cf-connecting-ip": freshIp() } });
    assert.equal(res.status, 403);
    assertHardened(res);
  });

  test("a foreign Origin sent with a non-form content type is rejected by the route (JSON 403)", async () => {
    const { res, json } = await post({}, { headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 403);
    assert.deepEqual(json, { ok: false, error: "forbidden" });
    assertHardened(res);
  });

  test('the literal Origin "null" counts as foreign', async () => {
    const { res } = await post(validFields(), { headers: { origin: "null", "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 403);
  });

  test("the same Origin is accepted", async () => {
    const { res } = await post({}, { headers: { origin: BASE } });
    assert.equal(res.status, 422);
  });

  test("a request without Origin (non-browser client) reaches validation", async () => {
    const { res } = await post({});
    assert.equal(res.status, 422);
  });
});

describe("size cap", () => {
  test("a body over 8 KB answers 413 {error:too_large} before any parsing", async () => {
    const { res, json } = await post(validFields({ comment: "x".repeat(9000) }));
    assert.equal(res.status, 413);
    assert.deepEqual(json, { ok: false, error: "too_large" });
    assertHardened(res);
  });

  test("a body just under the cap is still parsed (422 for the oversized comment, not 413)", async () => {
    const { res, json } = await post(validFields({ comment: "x".repeat(2000) }));
    assert.equal(res.status, 422);
    assert.deepEqual(json.fields, ["comment"]);
  });
});

describe("size cap, chunked", () => {
  /** A POST whose body is streamed (Transfer-Encoding: chunked, no Content-Length), `kb` KB in 1 KB pieces. */
  async function chunked(kb, ip = freshIp()) {
    const piece = new TextEncoder().encode("comment=" + "x".repeat(1016));
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (sent++ >= kb) return controller.close();
        controller.enqueue(piece);
      },
    });
    const res = await fetch(URL_, {
      method: "POST",
      body,
      duplex: "half",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "cf-connecting-ip": ip },
    });
    return { res, json: await res.json().catch(() => null) };
  }

  test("a chunked body over 8 KB (no Content-Length) answers 413 {error:too_large}", async () => {
    const { res, json } = await chunked(64);
    assert.equal(res.status, 413);
    assert.deepEqual(json, { ok: false, error: "too_large" });
    assertHardened(res);
  });

  test("a chunked body under the cap is still parsed (422 for the missing fields, not 413)", async () => {
    const { res, json } = await chunked(2);
    assert.equal(res.status, 422);
    assert.equal(json.error, "invalid");
  });
});

describe("limiter unavailable (own wrangler dev without the DELETION_LIMITER binding)", () => {
  test("fails open (request reaches validation) and logs a distinct PII-free warning", { timeout: 120_000 }, async () => {
    const dist = join(ROOT, "dist", "server");
    const config = join(dist, "wrangler.nolimiter.json");
    const cfg = JSON.parse(readText(join(dist, "wrangler.json"), "utf8"));
    cfg.ratelimits = [];
    if (cfg.previews) cfg.previews.ratelimits = [];
    writeFileSync(config, JSON.stringify(cfg));
    const port = await new Promise((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
    let out = "";
    const child = spawn("npx", ["--no-install", "wrangler", "dev", "--config", config, "--port", String(port), "--ip", "127.0.0.1", "--show-interactive-dev-session=false"], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    };
    try {
      const base = `http://127.0.0.1:${port}`;
      let up = false;
      for (const end = Date.now() + 90_000; Date.now() < end && !up; ) {
        up = await fetch(base + "/", { signal: AbortSignal.timeout(2000) }).then((r) => r.status === 200, () => false);
        if (!up) await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(up, "second wrangler dev did not start:\n" + out.slice(-1500));
      const marker = `lim${Date.now()}`;
      const res = await fetch(`${base}/api/delete-request`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "cf-connecting-ip": freshIp() },
        body: new URLSearchParams({ email: `${marker}@example.com`, role: "client" }).toString(),
      });
      assert.equal(res.status, 422, "without a limiter the request must still reach validation (fail-open)");
      assert.ok(await until(() => out.includes("delete-request: rate limiter unavailable")), "the distinct warning was not logged:\n" + out.slice(-1500));
      assert.equal(out.includes(marker), false, "submitted data leaked into the log");
    } finally {
      stop();
      rmSync(config, { force: true });
    }
  });
});
