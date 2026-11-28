// Phase 053 / WEB-72: build-failure email alerts. node:test, no wrangler, no network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toAlert } from "../ops/build-alerts/src/format.mjs";
import worker from "../ops/build-alerts/src/index.mjs";

const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/build-event-failed.json", import.meta.url), "utf8"));
const UUID = "11111111-2222-3333-4444-555555555555";

describe("toAlert", () => {
  test("failed fixture", () => {
    const a = toAlert(fixture());
    assert.equal(a.subject, "[Beautica] Збірка впала: beautica-site @ dev");
    assert.equal(a.buildUuid, UUID);
    assert.match(a.text, /прев'ю\/стейджинг/);
    assert.match(a.text, /abcdef0 fix: sample failing build/);
    assert.doesNotMatch(a.text, /abcdef01/);
    assert.match(a.text, new RegExp(`https://dash\\.cloudflare\\.com/\\S+/builds/${UUID}`));
  });
  test("canceled on main", () => {
    const e = fixture();
    e.type = "cf.workersBuilds.worker.build.canceled";
    e.payload.buildTriggerMetadata.branch = "main";
    const a = toAlert(e);
    assert.equal(a.subject, "[Beautica] Збірку скасовано: beautica-site @ main");
    assert.match(a.text, /прод/);
  });
  test("ignored types and junk return null", () => {
    for (const type of ["cf.workersBuilds.worker.build.succeeded", "cf.workersBuilds.worker.build.started", "other.thing"]) {
      const e = fixture();
      e.type = type;
      assert.equal(toAlert(e), null, type);
    }
    assert.equal(toAlert({}), null);
    assert.equal(toAlert(null), null);
    assert.equal(toAlert("x"), null);
  });
  test("missing workerName or buildUuid returns null", () => {
    const a = fixture();
    delete a.source.workerName;
    assert.equal(toAlert(a), null);
    const b = fixture();
    delete b.payload.buildUuid;
    assert.equal(toAlert(b), null);
  });
  test("missing optional fields use a dash", () => {
    const e = fixture();
    delete e.payload.buildTriggerMetadata.commitMessage;
    delete e.payload.stoppedAt;
    const a = toAlert(e);
    assert.match(a.text, /Зупинено: —/);
    assert.match(a.text, /Коміт: abcdef0 —/);
    assert.ok(toAlert({ type: "cf.workersBuilds.worker.build.failed", source: { workerName: "w" }, payload: { buildUuid: "u" } }));
  });
  test("only the first commit line, cut to 100 chars", () => {
    const e = fixture();
    e.payload.buildTriggerMetadata.commitMessage = `${"я".repeat(150)}\nsecond line marker`;
    const a = toAlert(e);
    assert.ok(a.text.includes("я".repeat(100)));
    assert.ok(!a.text.includes("я".repeat(101)));
    assert.ok(!a.text.includes("second line marker"));
  });
  test("no leakage of author, commands or provider account", () => {
    const e = fixture();
    const a = toAlert(e);
    const m = e.payload.buildTriggerMetadata;
    for (const v of [m.author, m.buildCommand, m.deployCommand, m.providerAccountName]) {
      assert.ok(v.startsWith("zz-"));
      assert.ok(!a.subject.includes(v) && !a.text.includes(v), v);
    }
  });
  test("CR/LF in branch cannot reach the subject", () => {
    const e = fixture();
    e.payload.buildTriggerMetadata.branch = "x\r\nBcc: a@b";
    const a = toAlert(e);
    assert.doesNotMatch(a.subject, /[\r\n]/);
    assert.ok(a.subject.length <= 200);
  });
  test("branch and workerName are capped at 100 chars", () => {
    const e = fixture();
    e.payload.buildTriggerMetadata.branch = "b".repeat(300);
    assert.ok(!toAlert(e).text.includes("b".repeat(101)));
  });
  test("invalid dashboard ids fall back to the placeholder link", () => {
    const e = fixture();
    e.metadata.accountId = "x/../evil";
    const a = toAlert(e);
    assert.match(a.text, /Збірка: —/);
    assert.doesNotMatch(a.text, /evil/);
  });
});

describe("queue consumer", () => {
  const msg = (body) => ({ body, acked: 0, retried: 0, ack() { this.acked++; }, retry() { this.retried++; } });

  test("alert is sent once and acked; ignored is acked, not sent", async () => {
    const sent = [];
    const env = { ALERT_MAIL: { send: async (m) => void sent.push(m) } };
    const a = msg(fixture());
    const b = msg({ type: "cf.workersBuilds.worker.build.succeeded" });
    await worker.queue({ messages: [a, b] }, env);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, "noreply@beautica.app");
    assert.equal(sent[0].to, "beautica.ua@gmail.com");
    assert.equal(sent[0].subject, "[Beautica] Збірка впала: beautica-site @ dev");
    assert.deepEqual([a.acked, a.retried, b.acked, b.retried], [1, 0, 1, 0]);
  });

  test("a throwing send retries and logs only the buildUuid", async () => {
    const env = { ALERT_MAIL: { send: async () => { throw new Error("secret-detail"); } } };
    const m = msg(fixture());
    const logged = [];
    const orig = console.error;
    console.error = (...args) => logged.push(args);
    try {
      await worker.queue({ messages: [m] }, env);
    } finally {
      console.error = orig;
    }
    assert.deepEqual([m.acked, m.retried], [0, 1]);
    assert.deepEqual(logged, [["build-alert send failed", UUID]]);
  });

  test("one failing send retries only that message", async () => {
    const env = { ALERT_MAIL: { send: async (m) => { if (m.text.includes("buildUuid: bad")) throw new Error("x"); } } };
    const good = msg(fixture());
    const badEvent = fixture();
    badEvent.payload.buildUuid = "bad";
    const bad = msg(badEvent);
    const junk = msg({ type: "other" });
    const orig = console.error;
    console.error = () => {};
    try {
      await worker.queue({ messages: [bad, good, junk] }, env);
    } finally {
      console.error = orig;
    }
    assert.deepEqual([good.acked, good.retried, bad.acked, bad.retried, junk.acked, junk.retried], [1, 0, 0, 1, 1, 0]);
  });
});

describe("queue consumer: every event type (W053)", () => {
  const msg = (body) => ({ body, acked: 0, retried: 0, ack() { this.acked++; }, retry() { this.retried++; } });
  const run = async (bodies) => {
    const sent = [];
    const ms = bodies.map(msg);
    await worker.queue({ messages: ms }, { ALERT_MAIL: { send: async (m) => void sent.push(m) } });
    return { sent, ms };
  };

  test("a cancelled build is mailed once and acked", async () => {
    const e = fixture();
    e.type = "cf.workersBuilds.worker.build.canceled";
    const { sent, ms } = await run([e]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, "[Beautica] Збірку скасовано: beautica-site @ dev");
    assert.deepEqual([ms[0].acked, ms[0].retried], [1, 0]);
  });

  test("succeeded and started events are acked without any mail", async () => {
    const { sent, ms } = await run(["succeeded", "started"].map((k) => ({ ...fixture(), type: `cf.workersBuilds.worker.build.${k}` })));
    assert.equal(sent.length, 0);
    assert.deepEqual(ms.map((m) => [m.acked, m.retried]), [[1, 0], [1, 0]]);
  });

  test("a malformed body (null, string, array, empty object) is acked, never mailed, never retried", async () => {
    const { sent, ms } = await run([null, "junk", [], {}, { type: "cf.workersBuilds.worker.build.failed" }]);
    assert.equal(sent.length, 0);
    assert.deepEqual(ms.map((m) => [m.acked, m.retried]), ms.map(() => [1, 0]));
  });
});

describe("wrangler config pins the alert pipeline (W053)", () => {
  const cfg = JSON.parse(readFileSync(new URL("../ops/build-alerts/wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  test("consumes beautica-build-events with max_retries 3", () => {
    assert.equal(cfg.queues.consumers.length, 1);
    assert.equal(cfg.queues.consumers[0].queue, "beautica-build-events");
    assert.equal(cfg.queues.consumers[0].max_retries, 3);
  });
  test("send_email binding ALERT_MAIL is locked to the verified destination and matches MAIL_TO", async () => {
    const { MAIL_TO } = await import("../ops/build-alerts/src/format.mjs");
    assert.deepEqual(cfg.send_email, [{ name: "ALERT_MAIL", destination_address: "beautica.ua@gmail.com" }]);
    assert.equal(cfg.send_email[0].destination_address, MAIL_TO);
  });
  test("never deployed to a public workers.dev URL", () => assert.equal(cfg.workers_dev, false));
});
