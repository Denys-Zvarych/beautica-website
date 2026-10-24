// Phase 013: the booking-link channel flag `?s=c|s`. The server never reads it (same HTML, same edge cache entry, canonical without a query);
// the page reads it client-side, maps it to {kind, source} for the Umami events, and strips it from the address bar.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { requireBase, rawRequest } from "./helpers/env.mjs";
import { bookPage } from "./helpers/book.mjs";

requireBase();
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());
const get = (path) => rawRequest(path, {});
const canon = (h) => h.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
// Fake Umami recorder, installed before any page script runs.
const SPY = `window.__ev=[];window.umami={track:function(e,p){window.__ev.push([e,p])}};`;

describe("server side: the flag changes nothing", () => {
  for (const [bare, base] of [["/book/chan-6001", "master"], ["/book/s/chans-6002", "salon"]]) {
    test(`${base}: ?s=c and ?s=s are 200, byte-identical to the bare page, one shared cache entry, canonical has no query`, async () => {
      const first = await get(bare);
      assert.equal(first.status, 200);
      assert.equal(first.headers["x-beautica-cache"], "MISS");
      for (const q of ["?s=c", "?s=s", "?s=x", "?s=c&utm_source=x"]) {
        const r = await get(bare + q);
        assert.equal(r.status, 200, q);
        assert.equal(r.headers["x-beautica-cache"], "HIT", `${q} shares the bare entry`);
        assert.equal(r.body, first.body, `${q} renders identical HTML`);
        assert.equal(canon(r.body), `https://beautica.app${bare}`);
      }
      assert.equal(first.body.includes('s=c"'), false);
    });
  }
  test("?sort=OLDEST&s=s keeps the sort: it is the OLDEST entry (not the bare one) and noindex,follow", async () => {
    const bare = await get("/book/oksana-ab12");
    const sorted = await get("/book/oksana-ab12?sort=OLDEST&s=s");
    assert.equal(sorted.status, 200);
    assert.notEqual(sorted.body, bare.body);
    const again = await get("/book/oksana-ab12?sort=OLDEST");
    assert.equal(again.headers["x-beautica-cache"], "HIT");
    assert.equal(again.body, sorted.body, "s did not fragment the sorted entry");
    assert.match(sorted.body, /<meta name="robots" content="noindex, follow"/);
  });
});

describe("client side: read, map, strip", () => {
  const cases = [
    ["/book/oksana-ab12?s=c", "/book/oksana-ab12", "master", "copy"],
    ["/book/oksana-ab12?s=s", "/book/oksana-ab12", "master", "share"],
    ["/book/s/lavanda-1111?s=s", "/book/s/lavanda-1111", "salon", "share"],
    ["/book/oksana-ab12?sort=OLDEST&s=s", "/book/oksana-ab12?sort=OLDEST", "master", "share"],
  ];
  for (const [path, after, kind, source] of cases) {
    test(`${path} -> {${kind}, ${source}}, address bar becomes ${after}`, async () => {
      const e = await bookPageWithSpy(path);
      try {
        const { page } = e;
        await page.waitForFunction(() => window.__ev.some((x) => x[0] === "link_open"));
        assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, after);
        const ev = await page.evaluate(() => window.__ev);
        const open = ev.find((x) => x[0] === "link_open");
        assert.equal(open[1].kind, kind);
        assert.equal(open[1].source, source);
        assert.deepEqual(Object.keys(open[1]).sort(), ["kind", "referrer_host", "source"]);
      } finally {
        await e.context.close();
      }
    });
  }
  test("?s=x and no flag -> source none; ?s=x stays untouched in the URL", async () => {
    for (const [path, src] of [["/book/oksana-ab12?s=x", "none"], ["/book/oksana-ab12", "none"], ["/book/oksana-ab12?s=C", "none"]]) {
      const e = await bookPageWithSpy(path);
      try {
        await e.page.waitForFunction(() => window.__ev.some((x) => x[0] === "link_open"));
        const ev = await e.page.evaluate(() => window.__ev);
        assert.equal(ev.find((x) => x[0] === "link_open")[1].source, src, path);
        assert.ok(ev.filter((x) => x[0] === "profile_view").every((x) => x[1].source === src));
      } finally {
        await e.context.close();
      }
    }
  });
});

async function bookPageWithSpy(path) {
  // bookPage navigates immediately, so the spy goes in through a context-level init script via a pre-open hook.
  return bookPage(browser, null, { path, init: SPY });
}

describe("hardening", () => {
  test("a throwing history.replaceState does not stop the page: link_open still fires, the CTA still wires", async () => {
    const e = await bookPage(browser, null, { path: "/book/oksana-ab12?s=c", init: SPY + `history.replaceState=function(){throw new Error("blocked")};` });
    try {
      await e.page.waitForFunction(() => window.__ev.some((x) => x[0] === "link_open"));
      const ev = await e.page.evaluate(() => window.__ev);
      assert.equal(ev.find((x) => x[0] === "link_open")[1].source, "copy");
      assert.equal(await e.page.locator("[data-book-cta]").evaluate((n) => !n.hidden), true, "main.ts went on to wire the CTA");
    } finally {
      await e.context.close();
    }
  });
  test("referrer_host: lowercased hostname, capped at 60, no path or query; own host is empty", async () => {
    const long = "A".repeat(70) + ".example.com";
    for (const [ref, want] of [[`https://${long}/secret/path?x=1`, (long.toLowerCase()).slice(0, 60)], ["https://Instagram.COM/p/abc?q=1", "instagram.com"]]) {
      const e = await bookPage(browser, null, { path: "/book/oksana-ab12?s=s", init: SPY + `Object.defineProperty(document,"referrer",{get:()=>${JSON.stringify(ref)}});` });
      try {
        await e.page.waitForFunction(() => window.__ev.some((x) => x[0] === "link_open"));
        const h = (await e.page.evaluate(() => window.__ev)).find((x) => x[0] === "link_open")[1].referrer_host;
        assert.equal(h, want);
        assert.ok(h.length <= 60 && !/[\/?]/.test(h));
      } finally {
        await e.context.close();
      }
    }
    const e = await bookPage(browser, null, { path: "/book/oksana-ab12", init: SPY + `Object.defineProperty(document,"referrer",{get:()=>location.origin+"/x"});` });
    try {
      await e.page.waitForFunction(() => window.__ev.some((x) => x[0] === "link_open"));
      assert.equal((await e.page.evaluate(() => window.__ev)).find((x) => x[0] === "link_open")[1].referrer_host, "");
    } finally {
      await e.context.close();
    }
  });
});

// QA additions (phase 013): pins what the parser does with odd inputs, and what the address bar looks like afterwards.
describe("edge inputs and the address bar", () => {
  const rows = [
    // [url, expected source, expected path+search+hash after load]
    ["/book/oksana-ab12?s=c&s=s", "copy", "/book/oksana-ab12"], // duplicate flag: first wins, every copy is stripped
    ["/book/oksana-ab12?s=s&s=c", "share", "/book/oksana-ab12"],
    ["/book/oksana-ab12?s=c#reviews", "copy", "/book/oksana-ab12#reviews"], // hash survives the strip
    ["/book/oksana-ab12?sort=OLDEST&s=c#reviews", "copy", "/book/oksana-ab12?sort=OLDEST#reviews"],
    ["/book/oksana-ab12?foo=1&s=s", "share", "/book/oksana-ab12?foo=1"], // other params survive
    ["/book/s/lavanda-1111?s=c#team", "copy", "/book/s/lavanda-1111#team"],
    ["/book/oksana-ab12?s=", "none", "/book/oksana-ab12?s="], // empty value: not a flag, left alone
    ["/book/oksana-ab12?s=cs", "none", "/book/oksana-ab12?s=cs"], // exact match only
    ["/book/oksana-ab12?s=x", "none", "/book/oksana-ab12?s=x"], // invalid value is never stripped nor echoed
    ["/book/oksana-ab12?s=x&s=c", "none", "/book/oksana-ab12?s=x&s=c"], // first value decides
    ["/book/oksana-ab12?S=c", "none", "/book/oksana-ab12?S=c"], // the key is case-sensitive
  ];
  for (const [path, source, bar] of rows) {
    test(`${path} -> source ${source}, address bar ${bar}`, async () => {
      const e = await bookPageWithSpy(path);
      try {
        await e.page.waitForFunction(() => window.__ev.some((x) => x[0] === "link_open"));
        const u = new URL(e.page.url());
        assert.equal(u.pathname + u.search + u.hash, bar);
        const open = (await e.page.evaluate(() => window.__ev)).find((x) => x[0] === "link_open");
        assert.equal(open[1].source, source);
        assert.equal(open[1].kind, path.startsWith("/book/s/") ? "salon" : "master");
      } finally {
        await e.context.close();
      }
    });
  }
  test("link_open fires exactly once per load", async () => {
    const e = await bookPageWithSpy("/book/oksana-ab12?s=c");
    try {
      await e.page.waitForFunction(() => window.__ev.some((x) => x[0] === "link_open"));
      await e.page.waitForLoadState("networkidle");
      assert.equal((await e.page.evaluate(() => window.__ev)).filter((x) => x[0] === "link_open").length, 1);
    } finally {
      await e.context.close();
    }
  });
});

describe("server side: the salon page and the SSR payload", () => {
  test("salon ?s=s: 200, shares the bare entry, flag never echoed into the HTML", async () => {
    const bare = await get("/book/s/chans-6002");
    const r = await get("/book/s/chans-6002?s=s");
    assert.equal(r.status, 200);
    assert.equal(r.headers["x-beautica-cache"], "HIT");
    assert.equal(r.body, bare.body);
    assert.equal(/[?&]s=s/.test(r.body), false);
  });
});
