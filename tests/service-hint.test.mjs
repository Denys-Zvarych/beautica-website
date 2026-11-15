// Phase 036: serviceNameHints unit matrix. F1-F9 are the shared fixture cases, mirrored verbatim from the app
// (beautica-mobile test/features/services/domain/service_name_hint_test.dart, phase 469): same inputs, same expected strings.
// The site formatter joins with U+00A0, the app with a plain space: compared after normalising NBSP -> space (D1).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { serviceNameHints } from "../src/lib/booking/serviceHint.ts";

const i = (id, name, durationMinutes, customName) => ({ id, name, durationMinutes, ...(customName === undefined ? {} : { customName }) });
const plain = (m) => Object.fromEntries([...m].map(([k, v]) => [k, v.replaceAll(" ", " ")]));

const FIXTURES = [
  ["F1 single service: no hint", [i("a", "Класичний масаж", 60)], {}],
  ["F2 same-name pair 60 + 90: duration hints", [i("a", "Класичний масаж", 60), i("b", "Класичний масаж", 90)], { a: "1 год", b: "1 год 30 хв" }],
  ["F3 pair differing only by case and outer spaces: grouped", [i("a", "Класичний масаж", 45), i("b", "  класичний МАСАЖ ", 30)], { a: "45 хв", b: "30 хв" }],
  ["F4 renamed copy: its own name, no hint; sibling alone: no hint", [i("a", "Класичний масаж", 60), i("b", "Масаж спини авторський", 90, "Масаж спини авторський")], {}],
  ["F5 custom name differs from the displayed name: custom name hint", [i("a", "Класичний масаж", 60, "Ранковий"), i("b", "Класичний масаж", 60)], { a: "Ранковий", b: "1 год" }],
  ["F6 custom name equal to displayed (case/space): duration hint", [i("a", "Класичний масаж", 60, " класичний масаж"), i("b", "Класичний масаж", 90)], { a: "1 год", b: "1 год 30 хв" }],
  ["F7 three copies: every member hinted", [i("a", "Стрижка", 30), i("b", "Стрижка", 60), i("c", "Стрижка", 90)], { a: "30 хв", b: "1 год", c: "1 год 30 хв" }],
  ["F8 two groups + a unique service in one list", [i("a", "Стрижка", 30), i("b", "Манікюр", 60), i("c", "Стрижка", 45), i("d", "Манікюр", 90), i("e", "Педикюр", 60)], { a: "30 хв", c: "45 хв", b: "1 год", d: "1 год 30 хв" }],
  ["F9 empty list: no hints", [], {}],
];

describe("serviceNameHints: shared fixture cases (mirrored from the app, 469)", () => {
  for (const [name, items, expected] of FIXTURES) test(name, () => assert.deepEqual(plain(serviceNameHints(items)), expected));
});

describe("serviceNameHints: rule details", () => {
  test("the site formatter keeps NBSP inside the hint (no wrap mid-duration)", () => {
    const h = serviceNameHints([i("a", "X", 90), i("b", "X", 20)]);
    assert.equal(h.get("a"), "1 год 30 хв");
    assert.equal(h.get("b"), "20 хв");
  });
  test("blank custom name falls back to the duration", () => {
    assert.deepEqual(plain(serviceNameHints([i("a", "X", 60, "   "), i("b", "X", 90, ""), i("c", "X", 30, null)])), { a: "1 год", b: "1 год 30 хв", c: "30 хв" });
  });
});
