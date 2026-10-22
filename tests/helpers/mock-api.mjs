// A tiny stand-in for the Beautica backend (PublicBookingController + PhoneOtpController), run by scripts/run-tests.mjs.
// The Worker fetches the link-page data from it (API_ORIGIN) and the browser calls it for availability / OTP / booking.
// Behaviour is chosen by the slug or the phone number, never by shared mutable state, so test files can run in parallel:
//   master slugs   oksana-ab12 (full)   sparse-0001 (no title/bio/photos/reviews)   closed-aaaa (bookable:false)   retired-bbbb (410)
//                  down-cccc (503)   limited-dddd (429)   conflict-9999 (booking -> 409)   bookdown-7777 (booking -> 503)
//                  expired-6666 (booking -> 401)   cache-4444 / headers-3333 / rail-8888 (a slug of their own for the cache / forwarded-header / 12-photo rail tests)   salonmaster-5555 (belongs to salon lavanda-1111)   anything else = 404
//   reviews        GET /book/{slug}/reviews and /book/s/{slug}/reviews: 12 fixed reviews, ?sort= (bad sort 400), page, size <= 20
//   booking        clientComment > 1000 chars or with control characters -> 400
//   salon slugs    lavanda-1111 (8 masters)   salonhdr-4444 (same, for the forwarded-header test)   shut-2222 (bookable:false)   anything else = 404
//   phone          ...0503 -> 503, ...0429 -> 429, ...0400 -> 400 "Verification failed"; anything else sends.   code 000000 = wrong, else ok
//   GET /__mock/log -> every request seen (method, path, headers, body), newest last.   POST /__mock/reset clears it.
import { createServer } from "node:http";

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

const MASTERS = {
  "oksana-ab12": () => masterInfo(),
  "sparse-0001": () => masterInfo({ masterName: "Нова Майстриня", avatarUrl: null, bio: null, professionalTitle: null, city: null, region: null, avgRating: null, reviewCount: 0, categories: [], ratingDistribution: DIST.map((b) => ({ ...b, count: 0 })), street: null, buildingNo: null, locationNote: null, portfolio: [], latestReviews: [] }),
  "closed-aaaa": () => masterInfo({ bookable: false }),
  "conflict-9999": () => masterInfo(),
  "bookdown-7777": () => masterInfo(),
  "expired-6666": () => masterInfo(),
  "evil-0666": () => masterInfo({ bio: EVIL.bio, professionalTitle: EVIL.title, latestReviews: [{ ...review(1, "Автор", 5, EVIL.comment, "Послуга", 1), clientDisplayName: EVIL.author }] }),
  "cache-4444": () => masterInfo(),
  "rail-8888": () => masterInfo({ portfolio: Array.from({ length: 12 }, (_, i) => ({ id: uid("a", i), entityType: "MASTER", entityId: MASTER_ID, mediaType: "PORTFOLIO", url: `${MEDIA}/p${i}.jpg`, createdAt: "2026-10-01T10:00:00Z" })) }),
  "headers-3333": () => masterInfo(),
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
  masters: Array.from({ length: 8 }, (_, i) => ({ masterSlug: i === 0 ? "oksana-ab12" : `master-${i}abc`, name: `Майстер${i + 1} Тест`, avatarUrl: null, professionalTitle: i % 2 ? "Косметолог" : "Майстер манікюру", avgRating: i === 2 ? null : [4.9, 4.8, null, 4.7, 5, 4.6, 4.9, 4.5][i], reviewCount: i === 2 ? 0 : 10 + i })),
  region: "Київська область",
  street: "вул. Хрещатик",
  buildingNo: "22",
  updatedAt: "2026-10-20T10:00:00Z",
  description: "Світлий салон у центрі Києва: манікюр, педикюр, брови.\nПрацюємо щодня.",
  locationNote: "Вхід з двору, 2 поверх",
  portfolio: [1, 2, 3, 4].map((n) => ({ id: uid("b", n), entityType: "SALON", entityId: "7a7a7a7a-1111-4222-8333-944455556666", mediaType: "PORTFOLIO", url: `${MEDIA}/s${n}.jpg`, createdAt: "2026-10-01T10:00:00Z" })),
  serviceCategories: [
    { category: "NAIL_SERVICE", displayName: "Нігтьовий сервіс", count: 2, services: [{ id: uid("d", 1), name: "Манікюр класичний", baseDurationMinutes: 60, priceDisplay: "450 ₴" }, { id: uid("d", 2), name: "Манікюр+гель лак", baseDurationMinutes: 90, priceDisplay: "650 ₴" }] },
    { category: "BROWS", displayName: "Оформлення брів", count: 1, services: [{ id: uid("d", 3), name: "Корекція брів", baseDurationMinutes: 30, priceDisplay: "600 - 900 ₴" }] },
  ],
  ratingDistribution: [5, 4, 3, 2, 1].map((rating, i) => ({ rating, count: [270, 30, 8, 3, 1][i] })),
  latestReviews: ALL_REVIEWS.slice(0, 5).map((r) => ({ ...r, masterFirstName: "Оксана", masterLastName: "Коваленко" })),
  ...over,
});
const SALONS = { "evilsalon-0666": () => salonInfo({ description: EVIL.salon }), "lavanda-1111": () => salonInfo(), "salonhdr-4444": () => salonInfo(), "shut-2222": () => salonInfo({ bookable: false, masters: [] }) };

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
      const f = SALONS[m[1]];
      return f ? json(res, 200, f(), { "cache-control": "public, max-age=0, s-maxage=30", etag: 'W/"s1"' }) : err(res, 404, "Not found");
    }
    if ((m = /^\/api\/v1\/book\/([a-z0-9-]+)\/info$/.exec(path))) {
      const slug = m[1];
      if (slug === "retired-bbbb") return err(res, 410, "Gone");
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
    if ((m = /^\/api\/v1\/book\/([a-z0-9-]+)\/availability$/.exec(path))) {
      if (!MASTERS[m[1]]) return err(res, 404, "Not found");
      const date = url.searchParams.get("date");
      const ids = url.searchParams.getAll("serviceId");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || ids.length === 0) return err(res, 400, "Bad request");
      const minutes = ids.reduce((a, id) => a + (SVC.find((s) => s.id === id)?.durationMinutes ?? 0), 0);
      return json(res, 200, slotsFor(date, minutes));
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
      if (slug === "bookdown-7777") return err(res, 503, "Service unavailable");
      const names = ids.map((id) => SVC.find((s) => s.id === id)?.name).filter(Boolean);
      const minutes = ids.reduce((a, id) => a + (SVC.find((s) => s.id === id)?.durationMinutes ?? 0), 0);
      return json(res, 201, { bookingId: "b0b0b0b0-1111-4222-8333-944455556666", appointmentId: ids.length > 1 ? "a0a0a0a0-1111-4222-8333-944455556666" : null, startsAt: b.startsAt, masterName: "Оксана Коваленко", serviceName: names.join(", "), durationMinutes: minutes, cancelUrl: CANCEL_URL });
    }
    return err(res, 404, "Not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { port, origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}
