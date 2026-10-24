// The account-deletion request dialog on /delete-account (src/components/DeleteRequestForm.astro): open, focus, close
// paths, validation, phone mask, submit success / 422 / server error / timeout, double submit, reduced motion, no-JS.
// The endpoint is mocked per test (isolation); one test at the end goes through the real local Worker.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, open, visibleBox } from "./helpers/browser.mjs";
import { BASE, freshIp, uk, requireBase } from "./helpers/env.mjs";

requireBase();
const dr = uk.deleteRequest;
const PAGE = BASE + "/delete-account";
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

/** Open /delete-account with the endpoint mocked. `respond(route, n)` decides each answer; returns the recorded posts. */
async function setup({ width = 360, respond, ...opts } = {}) {
  const env = await open(browser, { width, height: 900, ...opts });
  const posts = [];
  await env.context.route("**/api/delete-request", async (route) => {
    const req = route.request();
    posts.push({ method: req.method(), headers: req.headers(), body: req.postData() ?? "" });
    if (respond) return respond(route, posts.length);
    return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });
  await env.page.goto(PAGE);
  const page = env.page;
  const ui = {
    opener: page.getByRole("link", { name: uk.deleteAccount.cta }),
    dialog: page.getByRole("dialog", { name: dr.title }),
    email: page.getByLabel(dr.email),
    phone: page.getByLabel(dr.phone),
    role: page.getByLabel(dr.role),
    comment: page.getByLabel(dr.comment),
    consent: page.getByLabel(dr.consent),
    submit: page.getByRole("button", { name: dr.submit }),
    close: page.getByRole("button", { name: dr.close, exact: true }),
    banner: page.getByRole("alert").filter({ hasText: dr.error }),
    done: page.locator("#dr-done"),
  };
  const isOpen = () => page.evaluate(() => document.getElementById("delete-request-dialog").open);
  const fillValid = async (over = {}) => {
    await ui.email.fill(over.email ?? "client@example.com");
    await ui.role.selectOption(over.role ?? "client");
    if (over.phone) await ui.phone.fill(over.phone);
    await ui.consent.check();
  };
  return { ...env, posts, ui, isOpen, fillValid, async openDialog() { await ui.opener.click(); await ui.dialog.waitFor({ state: "visible" }); } };
}
const teardown = (env) => env.context.close();
const withDialog = (name, opts, fn) =>
  test(name, async () => {
    const env = await setup(opts);
    try {
      await env.openDialog();
      await fn(env);
      assert.deepEqual(env.problems.filter((p) => !/status of (4|5)\d\d/.test(p)), [], "unexpected console/page errors");
      assert.deepEqual(env.external, []);
    } finally {
      await teardown(env);
    }
  });

describe("opening and closing", () => {
  test("the dialog is closed on load and the opener opens it as a modal that takes focus and locks page scroll", async () => {
    const env = await setup();
    try {
      assert.equal(await env.isOpen(), false);
      assert.equal(await env.ui.dialog.isVisible(), false);
      await env.openDialog();
      assert.equal(await env.page.evaluate(() => document.getElementById("delete-request-dialog").matches(":modal")), true);
      assert.equal(await env.page.evaluate(() => document.getElementById("delete-request-dialog").contains(document.activeElement)), true, "focus moves into the dialog");
      assert.equal(await env.page.evaluate(() => getComputedStyle(document.body).overflow), "hidden");
      assert.ok(await visibleBox(env.ui.email) && (await visibleBox(env.ui.submit)));
    } finally {
      await teardown(env);
    }
  });

  withDialog("Esc closes it and focus returns to the opener", {}, async ({ page, ui, isOpen }) => {
    await page.keyboard.press("Escape");
    assert.equal(await isOpen(), false);
    assert.equal(await ui.opener.evaluate((el) => el === document.activeElement), true);
  });

  withDialog("the close button closes it", {}, async ({ ui, isOpen }) => {
    await ui.close.click();
    assert.equal(await isOpen(), false);
  });

  withDialog("a click on the backdrop closes it, a click inside the panel does not", { width: 1280 }, async ({ page, ui, isOpen }) => {
    await ui.email.click();
    assert.equal(await isOpen(), true);
    await page.mouse.click(4, 4);
    assert.equal(await isOpen(), false);
  });

  withDialog("Tab cycles through every field inside the modal and never lands on the honeypot", {}, async ({ page }) => {
    // 8 stops: close, email, phone, role, comment, consent, submit, mailto link (a 9th Tab leaves the page: native modal behaviour).
    const visited = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      const where = await page.evaluate(() => {
        const a = document.activeElement;
        return { inside: document.getElementById("delete-request-dialog").contains(a), name: a?.getAttribute("name") ?? a?.id ?? a?.tagName };
      });
      assert.equal(where.inside, true, `Tab #${i + 1} left the dialog`);
      visited.push(where.name);
    }
    assert.equal(visited.includes("website"), false, "keyboard reached the honeypot field");
    for (const f of ["email", "phone", "role", "comment", "consent", "dr-submit"]) assert.ok(visited.includes(f), `Tab never reached ${f}: ${visited}`);
  });

  test("without JS the opener keeps its mailto link and the dialog never shows", async () => {
    const { context, page } = await open(browser, { javaScriptEnabled: false });
    try {
      await page.goto(PAGE);
      const href = await page.getByRole("link", { name: uk.deleteAccount.cta }).getAttribute("href");
      assert.match(href, /^mailto:privacy@beautica\.app\?subject=/);
      assert.equal(await page.locator("#delete-request-dialog").isVisible(), false);
    } finally {
      await context.close();
    }
  });

  test("with JS the click opens the dialog instead of the mailto", async () => {
    const env = await setup();
    try {
      assert.match(await env.ui.opener.getAttribute("href"), /^mailto:/);
      await env.openDialog();
      assert.equal(env.page.url(), PAGE, "no navigation happened");
    } finally {
      await teardown(env);
    }
  });

  test("returning from a no-JS post (?sent=1) opens the dialog on the success panel, ?error=1 on the error banner", async () => {
    for (const [q, shown] of [["sent=1", "done"], ["error=1", "banner"]]) {
      const env = await setup();
      try {
        await env.page.goto(`${PAGE}?${q}`);
        await env.ui.dialog.waitFor({ state: "visible" });
        assert.equal(await env.ui[shown].isVisible(), true, `${q}: ${shown} should show`);
      } finally {
        await teardown(env);
      }
    }
  });
});

describe("validation", () => {
  withDialog("submitting an empty form shows the three required-field errors, focuses the first and sends nothing", {}, async ({ ui, page, posts }) => {
    await ui.submit.click();
    for (const m of [dr.errEmail, dr.errRole, dr.errConsent]) assert.equal(await page.getByText(m, { exact: true }).isVisible(), true, m);
    assert.equal(await page.getByText(dr.errPhone).isVisible(), false, "phone is optional");
    assert.equal(await ui.email.evaluate((el) => el === document.activeElement), true);
    assert.equal(await ui.email.getAttribute("aria-invalid"), "true");
    assert.equal(posts.length, 0);
  });

  withDialog("an error is described by its field (aria-describedby) and clears when the user types", {}, async ({ ui, page }) => {
    await ui.submit.click();
    assert.match(await ui.email.getAttribute("aria-describedby"), /dr-email-err/);
    await ui.email.fill("a");
    assert.equal(await page.getByText(dr.errEmail, { exact: true }).isVisible(), false);
    assert.equal(await ui.email.getAttribute("aria-invalid"), null);
  });

  withDialog("an email without a dot after the @ is rejected", {}, async ({ ui, page, fillValid, posts }) => {
    await fillValid({ email: "a@b" });
    await ui.submit.click();
    assert.equal(await page.getByText(dr.errEmail, { exact: true }).isVisible(), true);
    assert.equal(posts.length, 0);
  });

  withDialog("an incomplete phone is rejected with its own message; the hint gives way to it", {}, async ({ ui, page, fillValid, posts }) => {
    await fillValid({ phone: "0501" });
    await ui.submit.click();
    assert.equal(await page.getByText(dr.errPhone, { exact: true }).isVisible(), true);
    assert.equal(await page.getByText(dr.phoneHint).isVisible(), false);
    assert.equal(await ui.phone.evaluate((el) => el === document.activeElement), true);
    assert.equal(posts.length, 0);
  });

  withDialog("a comment over 1000 characters is rejected (maxlength is bypassed with a script)", {}, async ({ ui, page, fillValid, posts }) => {
    await fillValid();
    await ui.comment.evaluate((el) => {
      el.removeAttribute("maxlength");
      el.value = "x".repeat(1001);
    });
    await ui.submit.click();
    assert.equal(await page.getByText(dr.errComment, { exact: true }).isVisible(), true);
    assert.equal(posts.length, 0);
  });
});

describe("phone mask", () => {
  withDialog("typing 0501234567 digit by digit gives +380 (50) 123-45-67", {}, async ({ ui }) => {
    await ui.phone.pressSequentially("0501234567");
    assert.equal(await ui.phone.inputValue(), "+380 (50) 123-45-67");
  });

  for (const pasted of ["380501234567", "+380501234567", "050 123 45 67", "(050) 123-45-67"]) {
    withDialog(`pasting «${pasted}» is normalised to the mask`, {}, async ({ ui }) => {
      await ui.phone.fill(pasted);
      assert.equal(await ui.phone.inputValue(), "+380 (50) 123-45-67");
    });
  }

  withDialog("Backspace removes one digit at a time, never a separator character first", {}, async ({ ui, page }) => {
    await ui.phone.fill("0501234567");
    await ui.phone.focus();
    await page.keyboard.press("Backspace");
    assert.equal(await ui.phone.inputValue(), "+380 (50) 123-45-6");
    for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
    assert.equal(await ui.phone.inputValue(), "+380 (50) 12");
  });

  withDialog("letters are dropped", {}, async ({ ui }) => {
    await ui.phone.pressSequentially("05abc01");
    assert.equal(await ui.phone.inputValue(), "+380 (50) 1");
  });
});

describe("submit", () => {
  withDialog("success: sends one multipart POST with the entered fields, shows the confirmation, focuses it, and a reopen starts clean", {}, async ({ ui, page, posts, fillValid, isOpen }) => {
    await fillValid({ phone: "0501234567" });
    await ui.comment.fill("Прошу видалити");
    await ui.submit.click();
    await ui.done.waitFor({ state: "visible" });
    assert.equal(posts.length, 1);
    const p = posts[0];
    assert.equal(p.method, "POST");
    assert.equal(p.headers["accept"], "application/json");
    assert.match(p.headers["content-type"], /^multipart\/form-data; boundary=/);
    for (const [name, value] of [["email", "client@example.com"], ["phone", "+380 (50) 123-45-67"], ["role", "client"], ["comment", "Прошу видалити"], ["consent", "on"], ["website", ""]]) {
      assert.match(p.body, new RegExp(`name="${name}"\\r\\n\\r\\n${value.replace(/[()+]/g, "\\$&")}\\r\\n`), `field ${name}`);
    }
    assert.equal(await page.getByText(dr.sent, { exact: true }).isVisible(), true);
    assert.equal(await ui.done.evaluate((el) => el === document.activeElement), true, "focus moves to the confirmation");
    assert.equal(await page.locator("#dr-form").isVisible(), false);
    await page.getByRole("button", { name: dr.close, exact: true }).last().click();
    assert.equal(await isOpen(), false);
    await ui.opener.click();
    assert.equal(await ui.email.inputValue(), "", "the form is reset after a sent request");
    assert.equal(await page.locator("#dr-form").isVisible(), true);
  });

  test("while sending: button busy + relabelled, fields and close disabled, Esc and backdrop ignored; then it recovers", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const env = await setup({ width: 1280, respond: async (route) => (await gate, route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })) });
    try {
      await env.openDialog();
      await env.fillValid();
      await env.ui.submit.click();
      const busy = env.page.getByRole("button", { name: dr.sending });
      await busy.waitFor({ state: "visible" });
      assert.equal(await busy.getAttribute("aria-busy"), "true");
      assert.equal(await busy.isDisabled(), true);
      assert.equal(await env.ui.email.isDisabled(), true);
      assert.equal(await env.ui.close.isDisabled(), true);
      assert.equal(await env.page.locator("#dr-status").innerText(), dr.sendingStatus);
      await env.page.keyboard.press("Escape");
      await env.page.mouse.click(4, 4);
      assert.equal(await env.isOpen(), true, "Esc / backdrop must not close mid-send");
      release();
      await env.ui.done.waitFor({ state: "visible" });
      assert.equal(env.posts.length, 1);
    } finally {
      release();
      await teardown(env);
    }
  });

  test("double click on submit sends exactly one request", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const env = await setup({ respond: async (route) => (await gate, route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })) });
    try {
      await env.openDialog();
      await env.fillValid();
      await env.ui.submit.dblclick();
      await env.page.getByRole("button", { name: dr.sending }).waitFor({ state: "visible" });
      release();
      await env.ui.done.waitFor({ state: "visible" });
      assert.equal(env.posts.length, 1);
    } finally {
      release();
      await teardown(env);
    }
  });

  withDialog("server 422 with fields maps back to those fields, focuses the first, no banner", {
    respond: (route) => route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ ok: false, error: "invalid", fields: ["phone", "comment"] }) }),
  }, async ({ ui, page, fillValid, posts }) => {
    await fillValid();
    await ui.submit.click();
    await page.getByText(dr.errPhone, { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.getByText(dr.errComment, { exact: true }).isVisible(), true);
    assert.equal(await page.getByText(dr.errEmail, { exact: true }).isVisible(), false, "fields the server did not flag stay clean");
    assert.equal(await ui.phone.evaluate((el) => el === document.activeElement), true);
    assert.equal(await ui.banner.isVisible(), false);
    assert.equal(posts.length, 1);
    assert.equal(await ui.submit.isEnabled(), true);
  });

  for (const [name, status, body] of [["429 rate limited", 429, '{"ok":false,"error":"rate_limited"}'], ["502 send failed", 502, '{"ok":false,"error":"send_failed"}'], ["500 with a non-JSON body", 500, "oops"]]) {
    withDialog(`server ${name}: error banner (role=alert) with the mail fallback, input kept, button usable`, {
      respond: (route) => route.fulfill({ status, contentType: "text/plain", body }),
    }, async ({ ui, page, fillValid, posts }) => {
      await fillValid({ email: "keep@example.com" });
      await ui.submit.click();
      await ui.banner.waitFor({ state: "visible" });
      assert.match(await ui.banner.innerText(), /privacy@beautica\.app/);
      assert.equal(await ui.email.inputValue(), "keep@example.com");
      assert.equal(await ui.submit.isEnabled(), true);
      assert.equal(await ui.submit.evaluate((el) => el === document.activeElement), true, "focus returns to the submit button");
      assert.equal(await page.locator("#dr-done").isVisible(), false);
      assert.equal(posts.length, 1);
    });
  }

  test("network failure shows the banner; a retry then succeeds", async () => {
    const env = await setup({ respond: (route, n) => (n === 1 ? route.abort("failed") : route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })) });
    try {
      await env.openDialog();
      await env.fillValid();
      await env.ui.submit.click();
      await env.ui.banner.waitFor({ state: "visible" });
      await env.ui.submit.click();
      await env.ui.done.waitFor({ state: "visible" });
      assert.equal(env.posts.length, 2);
      assert.equal(await env.ui.banner.isVisible(), false);
    } finally {
      await teardown(env);
    }
  });

  test("a request that never answers is aborted after 20 s (fake clock) and shows the banner", async () => {
    const hung = [];
    const env = await setup({ respond: (route) => void hung.push(route) });
    try {
      await env.page.clock.install();
      await env.openDialog();
      await env.fillValid();
      await env.ui.submit.click();
      await env.page.getByRole("button", { name: dr.sending }).waitFor({ state: "visible" });
      await env.page.clock.fastForward(19_000);
      assert.equal(await env.ui.banner.isVisible(), false, "not aborted before 20 s");
      await env.page.clock.fastForward(2_000);
      await env.ui.banner.waitFor({ state: "visible" });
      assert.equal(await env.ui.submit.isEnabled(), true);
    } finally {
      await teardown(env);
    }
  });

  test("end to end through the real local Worker (no mock): request accepted, confirmation shown", async () => {
    const env = await open(browser, { width: 360, height: 900, extraHTTPHeaders: { "cf-connecting-ip": freshIp() } });
    try {
      await env.page.goto(PAGE);
      const page = env.page;
      await page.getByRole("link", { name: uk.deleteAccount.cta }).click();
      await page.getByLabel(dr.email).fill(`e2e-${Date.now()}@example.com`);
      await page.getByLabel(dr.role).selectOption("master");
      await page.getByLabel(dr.consent).check();
      await page.getByRole("button", { name: dr.submit }).click();
      await page.locator("#dr-done").waitFor({ state: "visible" });
      assert.deepEqual(env.problems, []);
    } finally {
      await teardown(env);
    }
  });
});

describe("reduced motion", () => {
  const animationOf = async (reducedMotion) => {
    const env = await setup({ reducedMotion });
    try {
      await env.openDialog();
      return await env.page.evaluate(() => {
        const d = document.getElementById("delete-request-dialog");
        return { dialog: getComputedStyle(d).animationName, backdrop: getComputedStyle(d, "::backdrop").animationName, anims: d.getAnimations({ subtree: true }).length };
      });
    } finally {
      await teardown(env);
    }
  };

  test("prefers-reduced-motion: no-preference animates the dialog in (guards the next test against a vacuous pass)", async () => {
    const a = await animationOf("no-preference");
    assert.notEqual(a.dialog, "none");
  });

  test("prefers-reduced-motion: reduce runs no dialog or backdrop animation", async () => {
    const a = await animationOf("reduce");
    assert.equal(a.dialog, "none");
    assert.equal(a.backdrop, "none");
    assert.equal(a.anims, 0);
  });

  test("with reduce, the success panel appears without animation too", async () => {
    const env = await setup({ reducedMotion: "reduce" });
    try {
      await env.openDialog();
      await env.fillValid();
      await env.ui.submit.click();
      await env.ui.done.waitFor({ state: "visible" });
      assert.equal(await env.page.evaluate(() => document.getElementById("delete-request-dialog").getAnimations({ subtree: true }).length), 0);
    } finally {
      await teardown(env);
    }
  });
});
