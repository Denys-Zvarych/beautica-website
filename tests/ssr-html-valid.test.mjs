// html-validate on the rendered SSR HTML of the link pages (mock backend): catches role / markup regressions that the static
// `html-validate dist/client` step cannot see, because these pages are not in dist/client.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HtmlValidate, FileSystemConfigLoader } from "html-validate/node";
import { rawRequest, requireBase, ROOT } from "./helpers/env.mjs";

requireBase();
const config = JSON.parse(readFileSync(`${ROOT}/.htmlvalidate.json`, "utf8"));
const validator = new HtmlValidate(config);
const PAGES = ["/book/oksana-ab12", "/book/sparse-0001", "/book/oksana-ab12?sort=OLDEST", "/book/s/lavanda-1111", "/book/s/lavanda-1111?sort=LOWEST", "/book/closed-aaaa", "/book/nobody-0000", "/book/s/shut-2222", "/book/evil-0666", "/book/s/wiz-html-0001", "/book/retired-bbbb", "/book/s/retiredsalon-bbbb", "/book-steps/salon"];

describe("rendered /book/* HTML validates", () => {
  for (const path of PAGES) {
    test(path, async () => {
      const html = (await rawRequest(path)).body;
      const report = await validator.validateString(html);
      assert.deepEqual(report.results.flatMap((r) => r.messages.map((m) => `${m.ruleId}: ${m.message} (line ${m.line})`)), []);
    });
  }
});
