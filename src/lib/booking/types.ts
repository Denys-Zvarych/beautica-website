// Wire types of the public booking-link endpoints (beautica-backend PublicBookingController, phases 380-382).
// Parsing is defensive: the API is trusted for shape but every optional field may be null, and anything unusable is dropped
// (an image URL that is not https never reaches the page).

export interface ServiceSummary {
  id: string;
  name: string;
  durationMinutes: number;
  priceFrom: number;
  /** Category key (joins `categories[].key`); null when the API did not send one. */
  category: string | null;
}
export interface RatingBucket {
  rating: number;
  count: number;
}
export interface ReviewItem {
  id: string;
  clientDisplayName: string;
  serviceName: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  /** Salon reviews only: "First Last" of the master the review is about. */
  masterName?: string | null;
}
export interface MasterInfo {
  slug: string;
  masterName: string;
  avatarUrl: string | null;
  bio: string | null;
  services: ServiceSummary[];
  masterId: string;
  professionalTitle: string | null;
  city: string | null;
  region: string | null;
  salon: { name: string; bookingSlug: string | null } | null;
  avgRating: number | null;
  reviewCount: number;
  categories: { id: string; name: string; key: string | null }[];
  ratingDistribution: RatingBucket[];
  street: string | null;
  buildingNo: string | null;
  locationNote: string | null;
  portfolio: string[];
  latestReviews: ReviewItem[];
  bookable: boolean;
  updatedAt: string | null;
}
export interface SalonMasterItem {
  masterSlug: string;
  name: string;
  avatarUrl: string | null;
  professionalTitle: string | null;
  /** null while the master has no reviews (the app shows «—»). */
  avgRating: number | null;
  reviewCount: number;
}
export interface SalonService {
  id: string;
  name: string;
  durationMinutes: number;
  priceLabel: string;
}
export interface SalonServiceGroup {
  category: string;
  displayName: string;
  count: number;
  services: SalonService[];
}
export interface SalonInfo {
  slug: string;
  salonId: string;
  name: string;
  city: string | null;
  region: string | null;
  street: string | null;
  buildingNo: string | null;
  avatarUrl: string | null;
  coverImageUrl: string | null;
  avgRating: number | null;
  reviewCount: number;
  bookable: boolean;
  masters: SalonMasterItem[];
  updatedAt: string | null;
  description: string | null;
  locationNote: string | null;
  portfolio: string[];
  serviceCategories: SalonServiceGroup[];
  ratingDistribution: RatingBucket[];
  latestReviews: ReviewItem[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Only https image URLs are ever rendered (also what the CSP img-src is derived from). */
export function safeImageUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function parseBuckets(v: unknown): RatingBucket[] {
  const out = arr(v).flatMap((b) => {
    const rating = isObj(b) ? num(b.rating) : null;
    const count = isObj(b) ? num(b.count) : null;
    return rating !== null && count !== null && rating >= 1 && rating <= 5 ? [{ rating: Math.round(rating), count: Math.max(0, count) }] : [];
  });
  // Always five rows, 5 -> 1, zero-filled: the bars never depend on what the API left out.
  return [5, 4, 3, 2, 1].map((r) => out.find((b) => b.rating === r) ?? { rating: r, count: 0 });
}

function parseReviews(v: unknown): ReviewItem[] {
  return arr(v).flatMap((r) => {
    if (!isObj(r)) return [];
    const rating = num(r.rating);
    const id = str(r.id);
    if (!id || rating === null) return [];
    const first = str(r.masterFirstName);
    const last = str(r.masterLastName);
    return [{ id, clientDisplayName: str(r.clientDisplayName) ?? "", serviceName: str(r.serviceName) ?? "", rating: Math.min(5, Math.max(0, Math.round(rating))), comment: str(r.comment), createdAt: str(r.createdAt) ?? "", masterName: [first, last].filter(Boolean).join(" ") || null }];
  });
}

/** One page of `/reviews` (PageResponse). */
export interface ReviewsPage {
  items: ReviewItem[];
  page: number;
  totalPages: number;
  totalElements: number;
}
export function parseReviewsPage(raw: unknown): ReviewsPage | null {
  if (!isObj(raw) || !Array.isArray(raw.data)) return null;
  return { items: parseReviews(raw.data), page: num(raw.page) ?? 0, totalPages: num(raw.totalPages) ?? 0, totalElements: num(raw.totalElements) ?? 0 };
}

export function parseMasterInfo(slug: string, raw: unknown): MasterInfo | null {
  if (!isObj(raw)) return null;
  const name = str(raw.masterName);
  const masterId = str(raw.masterId);
  if (!name || !masterId) return null;
  const salon = isObj(raw.salon) && str(raw.salon.name) ? { name: str(raw.salon.name) as string, bookingSlug: str(raw.salon.bookingSlug) } : null;
  return {
    slug,
    masterName: name,
    avatarUrl: safeImageUrl(raw.avatarUrl),
    bio: str(raw.bio),
    services: arr(raw.services).flatMap((s) => {
      if (!isObj(s)) return [];
      const id = str(s.id);
      const n = str(s.name);
      const d = num(s.durationMinutes);
      const p = num(s.priceFrom);
      return id && n && d !== null && p !== null ? [{ id, name: n, durationMinutes: d, priceFrom: p, category: str(s.category) }] : [];
    }),
    masterId,
    professionalTitle: str(raw.professionalTitle),
    city: str(raw.city),
    region: str(raw.region),
    salon,
    avgRating: num(raw.avgRating),
    reviewCount: Math.max(0, num(raw.reviewCount) ?? 0),
    categories: arr(raw.categories).flatMap((c) => (isObj(c) && str(c.id) && str(c.name) ? [{ id: str(c.id) as string, name: str(c.name) as string, key: str(c.key) }] : [])),
    ratingDistribution: parseBuckets(raw.ratingDistribution),
    street: str(raw.street),
    buildingNo: str(raw.buildingNo),
    locationNote: str(raw.locationNote),
    portfolio: arr(raw.portfolio).flatMap((m) => {
      const u = isObj(m) ? safeImageUrl(m.url) : null;
      return u ? [u] : [];
    }),
    latestReviews: parseReviews(raw.latestReviews),
    bookable: raw.bookable === true,
    updatedAt: str(raw.updatedAt),
  };
}

export function parseSalonInfo(slug: string, raw: unknown): SalonInfo | null {
  if (!isObj(raw)) return null;
  const name = str(raw.name);
  const salonId = str(raw.salonId);
  if (!name || !salonId) return null;
  return {
    slug,
    salonId,
    name,
    city: str(raw.city),
    region: str(raw.region),
    street: str(raw.street),
    buildingNo: str(raw.buildingNo),
    avatarUrl: safeImageUrl(raw.avatarUrl),
    coverImageUrl: safeImageUrl(raw.coverImageUrl),
    avgRating: num(raw.avgRating),
    reviewCount: Math.max(0, num(raw.reviewCount) ?? 0),
    bookable: raw.bookable === true,
    masters: arr(raw.masters).flatMap((m) => {
      if (!isObj(m)) return [];
      const masterSlug = str(m.masterSlug);
      const n = str(m.name);
      return masterSlug && n ? [{ masterSlug, name: n, avatarUrl: safeImageUrl(m.avatarUrl), professionalTitle: str(m.professionalTitle), avgRating: num(m.avgRating), reviewCount: Math.max(0, num(m.reviewCount) ?? 0) }] : [];
    }),
    updatedAt: str(raw.updatedAt),
    description: str(raw.description),
    locationNote: str(raw.locationNote),
    portfolio: arr(raw.portfolio).flatMap((m) => {
      const u = isObj(m) ? safeImageUrl(m.url) : null;
      return u ? [u] : [];
    }),
    serviceCategories: arr(raw.serviceCategories).flatMap((g) => {
      if (!isObj(g) || !str(g.category)) return [];
      const services = arr(g.services).flatMap((sv) => {
        if (!isObj(sv)) return [];
        const id = str(sv.id);
        const n = str(sv.name);
        const d = num(sv.baseDurationMinutes);
        return id && n && d !== null ? [{ id, name: n, durationMinutes: d, priceLabel: str(sv.priceDisplay) ?? "" }] : [];
      });
      return services.length === 0 ? [] : [{ category: str(g.category) as string, displayName: str(g.displayName) ?? (str(g.category) as string), count: Math.max(num(g.count) ?? 0, 0) || services.length, services }];
    }),
    ratingDistribution: parseBuckets(raw.ratingDistribution),
    latestReviews: parseReviews(raw.latestReviews),
  };
}
