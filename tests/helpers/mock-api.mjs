// A tiny stand-in for the Beautica backend (PublicBookingController + PhoneOtpController), run by scripts/run-tests.mjs.
// The Worker fetches the link-page data from it (API_ORIGIN) and the browser calls it for availability / OTP / booking.
// Behaviour is chosen by the slug or the phone number, never by shared mutable state, so test files can run in parallel:
//   master slugs   oksana-ab12 (full)   sparse-0001 (no title/bio/photos/reviews)   closed-aaaa (bookable:false)   retired-bbbb (410)
//                  down-cccc (503)   limited-dddd (429)   conflict-9999 (booking -> 409)   bookdown-7777 (booking -> 503)   nocancel-8888 (booking -> cancelUrl null)   foreigncancel-4242 (booking -> cancelUrl on a foreign host)   bookdays-5151 (unique to the bookable-days request test)
//                  expired-6666 (booking -> 401)   cache-4444 / headers-3333 / rail-8888 (a slug of their own for the cache / forwarded-header / 12-photo rail tests)   salonmaster-5555 (belongs to salon lavanda-1111)   salonnotitle-5656 (salon master without a professionalTitle)   anything else = 404
//   bookable-days  GET /book/{slug}/bookable-days?from&to&serviceId=...: Sundays are not working (and Saturdays when the pedicure service is among the ids); window outside today..today+60 -> 400; unknown service -> 404
//   reviews        GET /book/{slug}/reviews and /book/s/{slug}/reviews: 12 fixed reviews, ?sort= (bad sort 400), page, size <= 20
//   booking        clientComment > 1000 chars or with control characters -> 400
//   salon slugs    lavanda-1111 (8 masters)   salonhdr-4444 (same, for the forwarded-header test)   shut-2222 (bookable:false)   retiredsalon-bbbb (410 BOOKING_LINK_RETIRED)   anything else = 404
//   wizard salons  any slug starting "wiz" (wiz-<anything>): the salon booking wizard fixture (backend 391-393). 3 masters (two without a personal link), 4 services:
//                  S1 classic (M1, M2)   S2 gel (M1)   S3 brows (M2, M3)   S4 pedicure (nobody). M2 does not work on Mondays, every master not on Sundays.
//                  GET  /book/s/{slug}/masters/{masterId}/bookable-days | availability   (serviceId = that master's assignment id; foreign id -> 404)
//                  POST /book/s/{slug}/masters/{masterId}/booking   (body {masterServiceIds, ...}; a slug containing "c409" answers M2 with 409 for the 09:00 slot,
//                  "c401" answers M2 with 401; the same master + time twice = 409; a slug containing "dollar" names S3 «Брови $& тест»)
//   phone          ...0503 -> 503, ...0429 -> 429, ...0400 -> 400 "Verification failed"; anything else sends.   code 000000 = wrong, else ok
//   GET /__mock/log -> every request seen (method, path, headers, body), newest last.   POST /__mock/reset clears it.
import { createServer } from "node:http";
import { TEST_NOW } from "./env.mjs";

export const MASTER_ID = "5b6a7c8d-1111-4222-8333-944455556666";
export const SVC = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Манікюр класичний", durationMinutes: 60, priceFrom: 450, category: "NAIL_SERVICE" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Манікюр+гель лак", durationMinutes: 90, priceFrom: 650, category: "NAIL_SERVICE" },
  { id: "33333333-3333-4333-8333-333333333333", name: "Педикюр апаратний", durationMinutes: 90, priceFrom: 800, category: "PODOLOGY" },
  { id: "44444444-4444-4444-8444-444444444444", name: "Корекція брів", durationMinutes: 30, priceFrom: 250, category: "BROWS" },
];
// Ids are real UUIDs, as in the backend DTOs (tests/contract-booking-api.test.mjs validates every payload against them).
const uid = (kind, n) => `${kind}${String(n).padStart(7, "0")}-1111-4222-8333-944455556666`;
const CATS = [
  { id: uid("c", 1), name: "Нігтьовий сервіс", key: "NAIL_SERVICE" },
  { id: uid("c", 2), name: "Подологія", key: "PODOLOGY" },
  { id: uid("c", 3), name: "Оформлення брів", key: "BROWS" },
];
/** 110 + 14 + 3 + 1 + 0 = 128 reviews, as the design's example. */
export const DIST = [5, 4, 3, 2, 1].map((rating, i) => ({ rating, count: [110, 14, 3, 1, 0][i] }));
const ALL_REVIEWS = Array.from({ length: 12 }, (_, i) => ({
  id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
  masterId: MASTER_ID,
  clientDisplayName: `Клієнт${i} К.`,
  serviceName: SVC[i % 4].name,
  rating: [5, 4, 5, 3, 5, 1, 2, 5, 4, 5, 3, 4][i],
  comment: `Відгук номер ${i}`,
  createdAt: new Date(Date.now() - (i + 1) * 2 * 86400000).toISOString(),
}));
/** The page of reviews for a sort (the backend's SalonReviewSort): NEWEST/OLDEST by time, HIGHEST/LOWEST by rating then time. */
function reviewsPage(all, sort, page, size) {
  const byTime = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
  const sorted = [...all].sort(sort === "OLDEST" ? (a, b) => -byTime(a, b) : sort === "HIGHEST" ? (a, b) => b.rating - a.rating || byTime(a, b) : sort === "LOWEST" ? (a, b) => a.rating - b.rating || byTime(a, b) : byTime);
  const s = Math.min(size, 20);
  return { success: true, data: sorted.slice(page * s, page * s + s), message: null, page, size: s, totalElements: all.length, totalPages: Math.ceil(all.length / s) };
}
// A backend-host cancel link (foreigncancel-4242): the site must rebuild it on its OWN origin, never echo this host.
export const FOREIGN_CANCEL_URL = "https://api.evil-backend.example:8443/book/cancel/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee?utm=x#frag";
export const CANCEL_URL = "https://beautica.app/book/cancel/123e4567-e89b-42d3-a456-426614174000";
export const MEDIA = "https://media.beautica.test";
export const GUEST_TOKEN = "guest-token-ok";

const review = (n, author, rating, comment, service, days) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  masterId: MASTER_ID,
  clientDisplayName: author,
  serviceName: service,
  rating,
  comment,
  createdAt: new Date(Date.now() - days * 86400000).toISOString(),
});

/** Hostile text in every field a user controls: it must never become markup. */
export const EVIL = {
  bio: "</script><img src=x onerror=alert(1)>",
  title: "</SCRIPT ><svg onload=alert(2)>",
  comment: '<meta http-equiv=refresh content="0;url=https://evil.test"> & <!-- \u2028 -->',
  author: "<b>Автор</b>",
  salon: "</script><script>alert(3)</script>",
};

const masterInfo = (over = {}) => ({
  masterName: "Оксана Коваленко",
  avatarUrl: `${MEDIA}/avatar.jpg`,
  bio: "Роблю манікюр і педикюр у світлій студії.\nПрацюю з перевіреними матеріалами.",
  services: SVC,
  masterId: MASTER_ID,
  masterType: "INDEPENDENT_MASTER",
  professionalTitle: "Майстер манікюру та педикюру",
  city: "Київ",
  region: "Київська область",
  salon: null,
  avgRating: 4.9,
  reviewCount: 128,
  categories: CATS,
  ratingDistribution: DIST,
  street: "вул. Хрещатик",
  buildingNo: "22",
  locationNote: "2 поверх, офіс 5",
  portfolio: [1, 2, 3].map((n) => ({ id: uid("a", n), entityType: "MASTER", entityId: MASTER_ID, mediaType: "PORTFOLIO", url: `${MEDIA}/p${n}.jpg`, createdAt: "2026-10-01T10:00:00Z" })),
  latestReviews: [
    review(1, "Марина К.", 5, "Дуже акуратна робота, покриття тримається вже третій тиждень.", "Манікюр+гель лак", 3),
    review(2, "Ірина Л.", 4, "Тихо, чисто, ніяких черг.", "Манікюр класичний", 9),
    review(3, "Софія Т.", 5, null, "Педикюр апаратний", 20),
  ],
  bookable: true,
  updatedAt: "2026-10-20T10:00:00Z",
  ...over,
});

// Phase 036 copy-hint fixtures (own slugs, shared fixtures untouched): a master / a salon with two services of ONE displayed name (60 + 90 min) next to a unique one.
export const DUP_SVC = [
  { id: "a1111111-1111-4111-8111-111111111111", name: "Класичний масаж", durationMinutes: 60, priceFrom: 500, category: "NAIL_SERVICE" },
  { id: "a2222222-2222-4222-8222-222222222222", name: "Класичний масаж", durationMinutes: 90, priceFrom: 700, category: "NAIL_SERVICE" },
  { id: "a3333333-3333-4333-8333-333333333333", name: "Корекція брів", durationMinutes: 30, priceFrom: 250, category: "BROWS" },
];
const wizBooked = new Set();
const reviewSpent = new Set();
const MASTERS = {
  "oksana-ab12": () => masterInfo(),
  "dupcopy-0361": () => masterInfo({ services: DUP_SVC }), // phase 036: two same-name services (60 + 90 min) + a unique one
  "sparse-0001": () => masterInfo({ masterName: "Нова Майстриня", avatarUrl: null, bio: null, professionalTitle: null, city: null, region: null, avgRating: null, reviewCount: 0, categories: [], ratingDistribution: DIST.map((b) => ({ ...b, count: 0 })), street: null, buildingNo: null, locationNote: null, portfolio: [], latestReviews: [] }),
  "closed-aaaa": () => masterInfo({ bookable: false }),
  "conflict-9999": () => masterInfo(),
  "bookdown-7777": () => masterInfo(),
  "generic-4095": () => masterInfo(), // the booking POST answers a plain 400
  "blocked-4098": () => masterInfo(), // phase 020: the booking POST answers 409 BOOKING_UNAVAILABLE
  "blocked-4097": () => masterInfo(), // phase 020: same, a second page for the form-state / axe specs
  "conflictcode-4096": () => masterInfo(), // phase 020: the booking POST answers 409 with ANOTHER data.code: must stay a slot conflict
  "ambig-0001": () => masterInfo(),
  "ambig-5041": () => masterInfo(),
  "sortv-0001": () => masterInfo(),
  "ambig-5042": () => masterInfo(),
  "ambig-5043": () => masterInfo(),
  "store-0001": () => masterInfo(),
  "slotc-0001": () => masterInfo(),
  "daysr-0001": () => masterInfo(),
  "ambig-504a": () => masterInfo(),
  "nocancel-8888": () => masterInfo(),
  "tgdone-3131": () => masterInfo(), // booking response carries telegram {available:true, linked:false} (phase 022)
  "foreigncancel-4242": () => masterInfo(),
  "bookdays-5151": () => masterInfo(),
  "expired-6666": () => masterInfo(),
  "evil-0666": () => masterInfo({ bio: EVIL.bio, professionalTitle: EVIL.title, latestReviews: [{ ...review(1, "Автор", 5, EVIL.comment, "Послуга", 1), clientDisplayName: EVIL.author }] }),
  "cache-4444": () => masterInfo(),
  "chan-6001": () => masterInfo(),
  "rail-8888": () => masterInfo({ portfolio: Array.from({ length: 12 }, (_, i) => ({ id: uid("a", i), entityType: "MASTER", entityId: MASTER_ID, mediaType: "PORTFOLIO", url: `${MEDIA}/p${i}.jpg`, createdAt: "2026-10-01T10:00:00Z" })) }),
  "headers-3333": () => masterInfo(),
  "salonnotitle-5656": () => masterInfo({ masterName: "Дарина Мельник", professionalTitle: null, street: null, buildingNo: null, locationNote: null, salon: { name: "Салон «Лаванда»", bookingSlug: "lavanda-1111" } }),
  "salonmaster-5555": () => masterInfo({ masterName: "Дарина Мельник", street: null, buildingNo: null, locationNote: null, salon: { name: "Салон «Лаванда»", bookingSlug: "lavanda-1111" } }),
};

const salonInfo = (over = {}) => ({
  salonId: "7a7a7a7a-1111-4222-8333-944455556666",
  name: "Салон «Лаванда»",
  city: "Київ",
  avatarUrl: null,
  coverImageUrl: `${MEDIA}/cover.jpg`,
  avgRating: 4.8,
  reviewCount: 312,
  bookable: true,
  masters: Array.from({ length: 8 }, (_, i) => ({ masterSlug: i === 0 ? "oksana-ab12" : `master-${i}abc`, masterId: uid("e", 100 + i), name: `Майстер${i + 1} Тест`, avatarUrl: null, professionalTitle: i % 2 ? "Косметолог" : "Майстер манікюру", avgRating: i === 2 ? null : [4.9, 4.8, null, 4.7, 5, 4.6, 4.9, 4.5][i], reviewCount: i === 2 ? 0 : 10 + i })),
  region: "Київська область",
  street: "вул. Хрещатик",
  buildingNo: "22",
  updatedAt: "2026-10-20T10:00:00Z",
  description: "Світлий салон у центрі Києва: манікюр, педикюр, брови.\nПрацюємо щодня.",
  locationNote: "Вхід з двору, 2 поверх",
  portfolio: [1, 2, 3, 4].map((n) => ({ id: uid("b", n), entityType: "SALON", entityId: "7a7a7a7a-1111-4222-8333-944455556666", mediaType: "PORTFOLIO", url: `${MEDIA}/s${n}.jpg`, createdAt: "2026-10-01T10:00:00Z" })),
  serviceCategories: [
    { category: "NAIL_SERVICE", displayName: "Нігтьовий сервіс", count: 2, services: [{ id: uid("d", 1), name: "Манікюр класичний", baseDurationMinutes: 60, priceMin: 450, priceDisplay: "450 ₴" }, { id: uid("d", 2), name: "Манікюр+гель лак", baseDurationMinutes: 90, priceMin: 650, priceDisplay: "650 ₴" }] },
    { category: "BROWS", displayName: "Оформлення брів", count: 1, services: [{ id: uid("d", 3), name: "Корекція брів", baseDurationMinutes: 30, priceMin: 600, priceDisplay: "600 - 900 ₴" }] },
  ],
  // masters 0-1 do classic, master 1 gel, masters 3-4 brows (indexes into the roster above)
  serviceCoverage: [[1, [0, 1]], [2, [1]], [3, [3, 4]]].map(([n, ms]) => ({ serviceId: uid("d", n), masters: ms.map((i) => ({ masterId: uid("e", 100 + i), masterServiceId: uid("f", 100 + i * 10 + n) })) })),
  ratingDistribution: [5, 4, 3, 2, 1].map((rating, i) => ({ rating, count: [270, 30, 8, 3, 1][i] })),
  latestReviews: ALL_REVIEWS.slice(0, 5).map((r) => ({ ...r, masterFirstName: "Оксана", masterLastName: "Коваленко" })),
  ...over,
});
// ---- the salon wizard fixture (slugs "wiz*"): masters without a personal link, per-service coverage, per-master working days
export const WIZ = {
  salonId: "7a7a7a7a-2222-4222-8333-944455556666",
  masters: [1, 2, 3].map((n) => ({ n, id: uid("e", n), slug: n === 3 ? "master-3abc" : null, name: ["Олена Бондар", "Ірина Мельник", "Катерина Шевчук"][n - 1] })),
  services: [
    { n: 1, id: uid("d", 11), name: "Манікюр класичний", min: 60, price: 450, label: "450 ₴", category: "NAIL_SERVICE" },
    { n: 2, id: uid("d", 12), name: "Манікюр+гель лак", min: 90, price: 650, label: "650 ₴", category: "NAIL_SERVICE" },
    { n: 3, id: uid("d", 13), name: "Корекція брів", min: 30, price: 600, label: "600 - 900 ₴", category: "BROWS" },
    { n: 4, id: uid("d", 14), name: "Педикюр апаратний", min: 90, price: 800, label: "800 ₴", category: "PODOLOGY" },
  ],
  /** service n -> master numbers who perform it (roster order) */
  coverage: { 1: [1, 2], 2: [1], 3: [2, 3], 4: [] },
};
/** The assignment id of master m for service s (what the salon guest routes take as serviceId). */
/** The id of wizard master n (1-3 base, 4-8 only on "crowd" slugs). */
export const wizMasterId = (n) => uid("e", n);
export const wizAssign = (m, s) => uid("f", m * 10 + s);
const wizCats = [["NAIL_SERVICE", "Нігтьовий сервіс"], ["BROWS", "Оформлення брів"], ["PODOLOGY", "Подологія"]];
/** A slug containing "many" adds 12 more nail services (14 in all) so the 10-services cap can be reached. */
const wizExtra = (slug) => (slug.includes("many") ? Array.from({ length: 12 }, (_, i) => ({ n: 20 + i, id: uid("d", 20 + i), name: `Додаткова послуга ${i + 1}`, min: 30, price: 100, label: "100 ₴", category: "NAIL_SERVICE" })) : []);
/** A slug containing "crowd" adds 5 masters (8 in all, past the salon page's cap of 6) and makes the 8th the only one who does service 4. */
/** A slug containing "massage" adds two categories: the BODY_MASSAGE key, and an unknown key whose name only the keyword rule («масаж») resolves. */
const wizMassage = (slug) => (slug.includes("massage") ? [
  { category: "BODY_MASSAGE", displayName: "Масаж і догляд за тілом", count: 1, services: [{ id: uid("d", 40), name: "Релакс-масаж", baseDurationMinutes: 60, priceMin: 700, priceDisplay: "700 ₴" }] },
  { category: "NOPE", displayName: "Антицелюлітний масаж", count: 1, services: [{ id: uid("d", 41), name: "Антицелюліт", baseDurationMinutes: 45, priceMin: 500, priceDisplay: "500 ₴" }] },
] : []);
const wizCrowd = (slug) => (slug.includes("crowd") ? [4, 5, 6, 7, 8].map((n) => ({ n, id: uid("e", n), slug: null, name: `Майстер ${n}` })) : []);
const wizInfo = (slug = "") => ({
  salonId: WIZ.salonId,
  name: "Салон «Мозаїка»",
  city: "Львів",
  avatarUrl: null,
  coverImageUrl: null,
  avgRating: 4.7,
  reviewCount: 12,
  bookable: true,
  masters: [...WIZ.masters, ...wizCrowd(slug)].map((m) => ({ masterSlug: m.slug, masterId: m.id, name: m.name, avatarUrl: null, professionalTitle: m.n === 2 ? "Косметолог" : "Майстер манікюру", avgRating: m.n === 3 ? null : 4.8, reviewCount: m.n === 3 ? 0 : 5 })),
  region: "Львівська область",
  street: "вул. Городоцька",
  buildingNo: "7",
  updatedAt: "2026-10-20T10:00:00Z",
  description: "Салон для тестів майстра без особистого посилання.",
  locationNote: "2 поверх",
  portfolio: [],
  serviceCategories: wizCats.map(([category, displayName]) => {
    const services = [...WIZ.services, ...wizExtra(slug)].filter((sv) => sv.category === category).map((sv) => ({ id: sv.id, name: slug.includes("dollar") && sv.n === 3 ? "Брови $& тест" : sv.name, baseDurationMinutes: sv.min, priceMin: sv.price, priceDisplay: sv.label }));
    return { category, displayName, count: services.length, services };
  }).concat(wizMassage(slug)),
  ratingDistribution: [5, 4, 3, 2, 1].map((rating, i) => ({ rating, count: [8, 3, 1, 0, 0][i] })),
  latestReviews: [],
  serviceCoverage: [...WIZ.services, ...wizExtra(slug)].map((sv) => ({ serviceId: sv.id, masters: (slug.includes("crowd") && sv.n === 4 ? [8] : WIZ.coverage[sv.n] ?? [1]).map((m) => ({ masterId: uid("e", m), masterServiceId: wizAssign(m, sv.n) })) })),
});
const isWiz = (slug) => /^wiz/.test(slug);
/** Mondays are off for master 2, Sundays for everybody. */
const wizWorking = (masterN, date) => {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dow !== 0 && !(masterN === 2 && dow === 1);
};
/** The services of an assignment-id list for a master: null when an id is not one of that master's assignments. */
function wizResolve(masterId, ids) {
  const m = WIZ.masters.find((x) => x.id === masterId);
  if (!m || ids.length === 0 || ids.length > 10) return null;
  const out = [];
  for (const id of ids) {
    const sv = WIZ.services.find((x) => wizAssign(m.n, x.n) === id && WIZ.coverage[x.n].includes(m.n));
    if (!sv) return null;
    out.push(sv);
  }
  return { master: m, services: out };
}
// Hero-card fixtures (slug -> salon): rating line, address rule, note placement, image preconnect.
//   salonnew-7001   0 reviews, no rating, no street (city only), no cover/avatar, has a locationNote
//   salonbare-7002  nothing: no rating, no street, no city, no note, no images (no address row, no note)
//   salonrc{1,2,5,11}-70xx  4.8 with 1 / 2 / 5 / 11 reviews (the Ukrainian plural forms)
//   salonrated-7012 4.8 with 12 reviews, avatar on another origin than the cover (cover wins the preconnect)
const rc = (n, over = {}) => () => salonInfo({ avgRating: 4.8, reviewCount: n, ...over });
const HERO_SALONS = {
  "salonnew-7001": () => salonInfo({ avgRating: null, reviewCount: 0, street: null, buildingNo: null, city: "Львів", coverImageUrl: null, avatarUrl: null, locationNote: "Вхід з двору" }),
  "salonbare-7002": () => salonInfo({ avgRating: null, reviewCount: 0, street: null, buildingNo: null, city: null, region: null, coverImageUrl: null, avatarUrl: null, locationNote: null }),
  "salonrc1-7021": rc(1),
  "salonrc2-7022": rc(2),
  "salonrc5-7025": rc(5),
  "salonrc11-7031": rc(11),
  "salonrated-7012": rc(12, { coverImageUrl: "https://cover.beautica.test/c.jpg", avatarUrl: "https://avatar.beautica.test/a.jpg" }),
};
const dupSalon = () => salonInfo({ serviceCategories: [{ category: "NAIL_SERVICE", displayName: "Нігтьовий сервіс", count: 2, services: DUP_SVC.slice(0, 2).map((s, i) => ({ id: uid("d", 40 + i), name: s.name, baseDurationMinutes: s.durationMinutes, priceMin: s.priceFrom, priceDisplay: `${s.priceFrom} ₴` })) }, { category: "BROWS", displayName: "Оформлення брів", count: 1, services: [{ id: uid("d", 42), name: "Корекція брів", baseDurationMinutes: 30, priceMin: 250, priceDisplay: "250 ₴" }] }], serviceCoverage: [40, 41].map((n) => ({ serviceId: uid("d", n), masters: [0, 1].map((i) => ({ masterId: uid("e", 100 + i), masterServiceId: uid("f", 100 + i * 10 + n) })) })) });
const SALONS = { ...HERO_SALONS, "dupsalon-0362": dupSalon, "evilsalon-0666": () => salonInfo({ description: EVIL.salon }), "lavanda-1111": () => salonInfo(), "salonhdr-4444": () => salonInfo(), "chans-6002": () => salonInfo(), "shut-2222": () => salonInfo({ bookable: false, masters: [] }) };

/** UTC offset of Europe/Kyiv on a calendar date, "+02:00" / "+03:00". */
function kyivOffset(date) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Kyiv", timeZoneName: "longOffset" }).formatToParts(new Date(`${date}T12:00:00Z`));
  const o = p.find((x) => x.type === "timeZoneName").value.replace("GMT", "");
  return o === "" ? "+00:00" : o;
}
const TIMES = ["09:00", "10:30", "12:00", "13:30", "15:00", "16:30", "18:00", "19:30"];
/** Slots of a day: none on Sundays (the "no free time" state), otherwise TIMES sized to the summed duration. */
function slotsFor(date, minutes) {
  if (new Date(`${date}T12:00:00Z`).getUTCDay() === 0) return [];
  const off = kyivOffset(date);
  return TIMES.map((t) => {
    const [h, m] = t.split(":").map(Number);
    const end = h * 60 + m + minutes;
    const hh = String(Math.floor(end / 60)).padStart(2, "0");
    const mm = String(end % 60).padStart(2, "0");
    return { startsAt: `${date}T${t}:00${off}`, endsAt: `${date}T${hh}:${mm}:00${off}` };
  });
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};
const err = (res, status, message, headers) => json(res, status, { success: false, data: null, message }, headers);
/** The backend's retired-link answer (GoneException.BOOKING_LINK_RETIRED): 410 with a stable code under data.code. */
const gone = (res) => json(res, 410, { success: false, data: { code: "BOOKING_LINK_RETIRED" }, message: "Booking link is no longer valid" });
/** Backend 398 (BookingUnavailableException, built): the neutral «blocked phone» answer at booking create: 409 with the stable code under data.code (BookingUnavailableException). */
const unavailable = (res) => json(res, 409, { success: false, data: { code: "BOOKING_UNAVAILABLE" }, message: "Booking is not available" });
const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});

export async function startMockApi() {
  /** @type {{method:string, path:string, headers:Record<string,string|string[]|undefined>, body:any}[]} */
  const log = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    const path = url.pathname;
    if (req.method === "OPTIONS") return json(res, 204, undefined, { "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type, authorization, accept" });
    const raw = req.method === "POST" ? await readBody(req) : "";
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    if (path === "/__mock/log") return json(res, 200, log);
    if (path === "/__mock/reset") return log.length = 0, json(res, 200, {});
    log.push({ method: req.method, path: path + url.search, headers: { ...req.headers }, body });

    let m;
    if ((m = /^\/api\/v1\/book\/s\/([a-z0-9-]+)\/info$/.exec(path))) {
      if (m[1].startsWith("retiredsalon")) return gone(res);
      const f = isWiz(m[1]) ? () => wizInfo(m[1]) : SALONS[m[1]];
      return f ? json(res, 200, f(), { "cache-control": "public, max-age=0, s-maxage=30", etag: 'W/"s1"' }) : err(res, 404, "Not found");
    }
    if ((m = /^\/api\/v1\/book\/([a-z0-9-]+)\/info$/.exec(path))) {
      const slug = m[1];
      if (slug === "retired-bbbb") return gone(res);
      if (slug === "down-cccc") return err(res, 503, "Service unavailable", { "retry-after": "7" });
      if (slug === "limited-dddd") return err(res, 429, "Too many requests", { "retry-after": "12" });
      const f = MASTERS[slug];
      return f ? json(res, 200, f(), { "cache-control": "public, max-age=0, s-maxage=30", etag: 'W/"m1"' }) : err(res, 404, "Not found");
    }
    if ((m = /^\/api\/v1\/book\/(s\/)?([a-z0-9-]+)\/reviews$/.exec(path))) {
      const salon = !!m[1];
      if (!(salon ? SALONS : MASTERS)[m[2]]) return err(res, 404, "Not found");
      const sort = url.searchParams.get("sort") ?? "NEWEST";
      if (!["NEWEST", "OLDEST", "HIGHEST", "LOWEST"].includes(sort)) return err(res, 400, "Invalid sort");
      const page = Number(url.searchParams.get("page") ?? 0);
      const size = Number(url.searchParams.get("size") ?? 20);
      return json(res, 200, reviewsPage(ALL_REVIEWS, sort, page, size), { "cache-control": "public, max-age=0, s-maxage=30", etag: 'W/"r1"' });
    }
    if ((m = /^\/api\/v1\/book\/s\/([a-z0-9-]+)\/masters\/([0-9a-f-]+)\/(availability|bookable-days|booking)$/.exec(path))) {
      const [, slug, masterId, what] = m;
      if (!isWiz(slug)) return err(res, 404, "Not found");
      const ids = url.searchParams.getAll("serviceId");
      if (what === "booking") {
        if (req.method !== "POST") return err(res, 404, "Not found");
        const b = body ?? {};
        if (req.headers.authorization !== `Bearer ${GUEST_TOKEN}`) return err(res, 401, "Unauthorized");
        if (b.privacyAccepted !== true || !b.privacyPolicyVersion || !b.name || !b.surname || !b.startsAt || !Array.isArray(b.masterServiceIds) || b.serviceId !== undefined) return err(res, 400, "Validation failed");
        const r = wizResolve(masterId, b.masterServiceIds);
        if (!r) return err(res, 404, "Not found");
        if (b.clientComment !== undefined && (typeof b.clientComment !== "string" || b.clientComment.length > 1000)) return err(res, 400, "Comment must be at most 1000 characters");
        if (slug.includes("blk") && r.master.n === 1) return unavailable(res);
        if (slug.includes("c409") && r.master.n === 2 && /T09:00:00/.test(b.startsAt)) return err(res, 409, "Slot not available");
        if (slug.includes("c401") && r.master.n === 2) return err(res, 401, "Unauthorized");
        // A booking exists once accepted: the same master and time again is a conflict (what the real backend answers), which is how the
        // "response dropped, then retried" case shows up.
        const taken = `${slug}|${masterId}|${b.startsAt}`;
        if (wizBooked.has(taken)) return err(res, 409, "Slot not available");
        wizBooked.add(taken);
        const minutes = r.services.reduce((a, x) => a + x.min, 0);
        return json(res, 201, { bookingId: uid("1", r.master.n), appointmentId: r.services.length > 1 ? uid("2", r.master.n) : null, startsAt: b.startsAt, masterName: r.master.name, serviceName: r.services.map((x) => x.name).join(", "), durationMinutes: minutes, cancelUrl: `https://beautica.app/book/cancel/123e4567-e89b-42d3-a456-42661417400${r.master.n}` });
      }
      const r = wizResolve(masterId, ids);
      if (!r) return err(res, 404, "Not found");
      if (what === "availability") {
        const date = url.searchParams.get("date");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return err(res, 400, "Bad request");
        const minutes = r.services.reduce((a, x) => a + x.min, 0);
        return json(res, 200, wizWorking(r.master.n, date) ? slotsFor(date, minutes) : []);
      }
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return err(res, 400, "Bad request");
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date(TEST_NOW));
      const iso = (d) => d.toISOString().slice(0, 10);
      const max = iso(new Date(new Date(`${today}T12:00:00Z`).getTime() + 60 * 86400000));
      if (from < today || to > max) return err(res, 400, "Window out of range");
      const out = [];
      for (let d = new Date(`${from}T12:00:00Z`); iso(d) <= to; d = new Date(d.getTime() + 86400000)) out.push({ date: iso(d), working: wizWorking(r.master.n, iso(d)) });
      return json(res, 200, out);
    }
    if ((m = /^\/api\/v1\/book\/([a-z0-9-]+)\/availability$/.exec(path))) {
      if (!MASTERS[m[1]]) return err(res, 404, "Not found");
      const date = url.searchParams.get("date");
      const ids = url.searchParams.getAll("serviceId");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || ids.length === 0) return err(res, 400, "Bad request");
      const minutes = ids.reduce((a, id) => a + ([...SVC, ...DUP_SVC].find((s) => s.id === id)?.durationMinutes ?? 0), 0);
      return json(res, 200, slotsFor(date, minutes));
    }
    if ((m = /^\/api\/v1\/book\/([a-z0-9-]+)\/bookable-days$/.exec(path))) {
      // Backend 387: [{date, working}] per day of [from, to]; window inside [today, today+60] (Kyiv) else 400. Sundays are the non-working days (as slotsFor).
      if (!MASTERS[m[1]]) return err(res, 404, "Not found");
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const ids = url.searchParams.getAll("serviceId");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || ids.length === 0 || ids.length > 10 || from > to) return err(res, 400, "Bad request");
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date(TEST_NOW));
      const iso = (d) => d.toISOString().slice(0, 10);
      const max = iso(new Date(new Date(`${today}T12:00:00Z`).getTime() + 60 * 86400000));
      if (from < today || to > max) return err(res, 400, "Window out of range");
      if (ids.some((id) => ![...SVC, ...DUP_SVC].some((s) => s.id === id))) return err(res, 404, "Not found");
      const out = [];
      for (let d = new Date(`${from}T12:00:00Z`); iso(d) <= to; d = new Date(d.getTime() + 86400000)) out.push({ date: iso(d), working: d.getUTCDay() !== 0 && !(ids.includes(SVC[2].id) && d.getUTCDay() === 6) });
      return json(res, 200, out);
    }
    if (path === "/api/v1/book/otp/send" && req.method === "POST") {
      const b = body ?? {};
      if (b.privacyAccepted !== true || !/^\d{4}-\d{2}-\d{2}(\.\d{1,3})?$/.test(b.privacyPolicyVersion ?? "") || !/^\+380\d{9}$/.test(b.phone ?? "")) return err(res, 400, "Validation failed");
      if (!b.turnstileToken) return err(res, 400, "Verification failed");
      if (b.phone.endsWith("0400")) return err(res, 400, "Verification failed");
      if (b.phone.endsWith("0503")) return err(res, 503, "SMS unavailable", { "retry-after": "30" });
      if (b.phone.endsWith("0429")) return err(res, 429, "Too many requests", { "retry-after": "60" });
      return json(res, 200, { success: true, data: null, message: null });
    }
    if (path === "/api/v1/book/otp/verify" && req.method === "POST") {
      const b = body ?? {};
      if (!/^\+380\d{9}$/.test(b.phone ?? "") || !/^\d{6}$/.test(b.code ?? "")) return err(res, 400, "Validation failed");
      if (b.phone.endsWith("0429")) return err(res, 429, "Too many requests");
      if (b.code === "000000") return err(res, 401, "Invalid or expired code");
      if (b.phone.endsWith("0409")) return unavailable(res); // phase 020: the code is booking-create only; on OTP verify it must NOT become the blocked banner
      return json(res, 200, { success: true, data: { guestToken: GUEST_TOKEN }, message: null });
    }
    if ((m = /^\/api\/v1\/book\/([a-z0-9-]+)\/booking$/.exec(path)) && req.method === "POST") {
      const slug = m[1];
      if (!MASTERS[slug]) return err(res, 404, "Not found");
      if (req.headers.authorization !== `Bearer ${GUEST_TOKEN}` || slug === "expired-6666") return err(res, 401, "Unauthorized");
      const b = body ?? {};
      const ids = b.masterServiceIds ?? (b.serviceId ? [b.serviceId] : []);
      if (b.privacyAccepted !== true || !b.privacyPolicyVersion || !b.name || !b.surname || !b.startsAt || ids.length === 0 || (b.serviceId && b.masterServiceIds)) return err(res, 400, "Validation failed");
      if (b.clientComment !== undefined && (typeof b.clientComment !== "string" || b.clientComment.length > 1000 || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(b.clientComment))) return err(res, 400, "Comment must be at most 1000 characters");
      if (slug === "conflict-9999") return err(res, 409, "Slot not available");
      if (slug.startsWith("generic-")) return err(res, 400, "Validation failed");
      if (slug.startsWith("blocked-")) return unavailable(res);
      if (slug.startsWith("conflictcode-")) return json(res, 409, { success: false, data: { code: "SLOT_TAKEN" }, message: "Slot not available" });
      if (slug === "bookdown-7777") return err(res, 503, "Service unavailable");
      // A slug containing "ambig": a booking exists once accepted, the same time again is a conflict (the "answer lost, then resent" case).
      if (slug.includes("ambig")) {
        const k = `${slug}|${b.startsAt}`;
        if (wizBooked.has(k)) return err(res, 409, "Slot not available");
        wizBooked.add(k);
      }
      const names = ids.map((id) => [...SVC, ...DUP_SVC].find((s) => s.id === id)?.name).filter(Boolean);
      const minutes = ids.reduce((a, id) => a + ([...SVC, ...DUP_SVC].find((s) => s.id === id)?.durationMinutes ?? 0), 0);
      return json(res, 201, { bookingId: "b0b0b0b0-1111-4222-8333-944455556666", appointmentId: ids.length > 1 ? "a0a0a0a0-1111-4222-8333-944455556666" : null, startsAt: b.startsAt, masterName: "Оксана Коваленко", serviceName: names.join(", "), durationMinutes: minutes, cancelUrl: slug === "nocancel-8888" ? null : slug === "foreigncancel-4242" ? FOREIGN_CANCEL_URL : CANCEL_URL, ...(slug.startsWith("tgdone") ? { telegram: { available: true, linked: false } } : {}) });
    }
    // Guest review invites, the real backend 401 shapes (bare JSON, state discriminator, null fields omitted). Tokens by prefix (16+ chars, [A-Za-z0-9_-]):
    //   rvopen...   one service (master)      rvmulti...  two services (master)      rvsalon...  two services, two masters (salon)
    //   rvdone...   200 {state: ALREADY_REVIEWED} (consumed)      rvlimit... GET 429      rvdown... GET 503      anything else = 404 (unknown / expired alike)
    //   opt-out: 404 for rvoptgone... (an open form whose token dies before the opt-out)
    //   submit: 404 for rvgone... (spent meanwhile), 409 for rvconf..., 429 for rvslow..., 400 for rvbad..., 201 otherwise (each token is single-use: a 2nd submit = 404)
    if ((m = /^\/api\/v1\/public\/review-invites\/([A-Za-z0-9_-]+)(\/reviews|\/opt-out)?$/.exec(path))) {
      const [, tok, tail] = m;
      if (!tail && req.method === "GET") {
        if (tok.startsWith("rvdone")) return json(res, 200, { state: "ALREADY_REVIEWED" });
        if (tok.startsWith("rvlimit")) return err(res, 429, "Too many requests", { "retry-after": "20" });
        if (tok.startsWith("rvdown")) return err(res, 503, "Service unavailable", { "retry-after": "9" });
        const o = { state: "OPEN", providerName: "Оксана Коваленко", providerType: "MASTER", visitDate: "2026-10-24", displayName: "Олена К.", avgRating: 4.9, reviewCount: 128, professionalTitle: "Манікюр та педикюр" };
        if (tok.startsWith("rvavatar")) return json(res, 200, { ...o, avatarUrl: `${MEDIA}/a.png`, items: [{ bookingId: uid("5", 1), serviceName: "Манікюр+гель лак", masterName: "Оксана Коваленко" }] });
        if (tok.startsWith("rvevil")) return json(res, 200, { ...o, avatarUrl: "https://evil.example/a.png", items: [{ bookingId: uid("5", 1), serviceName: "Манікюр+гель лак", masterName: "Оксана Коваленко" }] });
        if (tok.startsWith("rvnorate")) { const { avgRating, professionalTitle, ...bare } = o; return json(res, 200, { ...bare, reviewCount: 0, items: [{ bookingId: uid("5", 1), serviceName: "Манікюр+гель лак", masterName: "Оксана Коваленко" }] }); }
        if (tok.startsWith("rvsalonupper")) return json(res, 200, { ...o, providerName: "САЛОН «Лаванда»", providerType: "SALON", professionalTitle: undefined, items: [{ bookingId: uid("5", 1), serviceName: "Манікюр+гель лак", masterName: "Оксана Коваленко" }, { bookingId: uid("5", 2), serviceName: "Педикюр класичний", masterName: "Ірина Мельник" }] });
        if (tok.startsWith("rvsalonplain")) return json(res, 200, { ...o, providerName: "Студія «Лаванда»", providerType: "SALON", professionalTitle: undefined, items: [{ bookingId: uid("5", 1), serviceName: "Манікюр+гель лак", masterName: "Оксана Коваленко" }, { bookingId: uid("5", 2), serviceName: "Педикюр класичний", masterName: "Ірина Мельник" }] });
        if (tok.startsWith("rvsalon")) return json(res, 200, { ...o, providerName: "Салон «Лаванда»", providerType: "SALON", professionalTitle: undefined, items: [{ bookingId: uid("5", 1), serviceName: "Манікюр+гель лак", masterName: "Оксана Коваленко" }, { bookingId: uid("5", 2), serviceName: "Педикюр класичний", masterName: "Ірина Мельник" }] });
        if (tok.startsWith("rvmulti")) return json(res, 200, { ...o, items: [{ bookingId: uid("5", 1), serviceName: "Манікюр+гель лак", masterName: "Оксана Коваленко" }, { bookingId: uid("5", 2), serviceName: "Педикюр класичний", masterName: "Оксана Коваленко" }] });
        if (tok.startsWith("rvopen") || tok.startsWith("rv") && /^rv(gone|conf|slow|bad|opt|blk)/.test(tok)) return json(res, 200, { ...o, items: [{ bookingId: uid("5", 1), serviceName: "Манікюр+гель лак", masterName: "Оксана Коваленко" }] });
        return err(res, 404, "Not found");
      }
      if (req.method !== "POST" || !tail) return err(res, 404, "Not found");
      if (tail === "/reviews") {
        if (tok.startsWith("rvgone") || reviewSpent.has(tok)) return err(res, 404, "Not found");
        if (tok.startsWith("rvconf")) return err(res, 409, "Already reviewed");
        if (tok.startsWith("rvblk")) return unavailable(res); // 409 + BOOKING_UNAVAILABLE on a REVIEW call: must stay a plain conflict (the code is booking-create only)
        if (tok.startsWith("rvslow")) return err(res, 429, "Too many requests", { "retry-after": "60" });
        const b = body ?? {};
        if (tok.startsWith("rvbad") || !Array.isArray(b.items) || b.items.length === 0 || b.items.some((i) => !(i.rating >= 1 && i.rating <= 5) || (i.comment !== undefined && (typeof i.comment !== "string" || i.comment.length > 2000)))) return err(res, 400, "Validation failed");
        if (!b.turnstileToken) return err(res, 400, "Verification failed");
        reviewSpent.add(tok);
        return json(res, 201, { created: b.items.length });
      }
      if (tok.startsWith("rvoptgone")) return err(res, 404, "Not found"); // opt-out: the token was spent / expired meanwhile
      if (!(body ?? {}).turnstileToken) return err(res, 400, "Verification failed");
      if (tok.startsWith("rvslow")) return err(res, 429, "Too many requests", { "retry-after": "60" });
      return json(res, 204, undefined);
    }
    return err(res, 404, "Not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { port, origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}
