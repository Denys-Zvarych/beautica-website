// Display formatting shared by the SSR pages and the booking island (pure, no DOM). Currency is ₴; times are Europe/Kyiv.

export const KYIV = "Europe/Kyiv";
const nbsp = " ";

/** 1250 -> "1 250" (no-break space groups). */
export function groupThousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, nbsp);
}

/** The API sends `priceFrom` only (no max, no price type), so every price reads "від N ₴". */
export function formatPriceFrom(n: number): string {
  return `від${nbsp}${groupThousands(n)}${nbsp}₴`;
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (minutes < 60) return `${minutes}${nbsp}хв`;
  return m ? `${h}${nbsp}год${nbsp}${m}${nbsp}хв` : `${h}${nbsp}год`;
}

/** 1 послуга / 2 послуги / 5 послуг. */
export function pluralServices(n: number): string {
  const m100 = n % 100;
  const m10 = n % 10;
  const word = m100 >= 11 && m100 <= 14 ? "послуг" : m10 === 1 ? "послуга" : m10 >= 2 && m10 <= 4 ? "послуги" : "послуг";
  return `${n} ${word}`;
}

export function pluralReviews(n: number): string {
  const m100 = n % 100;
  const m10 = n % 10;
  const word = m100 >= 11 && m100 <= 14 ? "відгуків" : m10 === 1 ? "відгук" : m10 >= 2 && m10 <= 4 ? "відгуки" : "відгуків";
  return `${n} ${word}`;
}

/** One decimal, comma-free ("4.9" as the app shows it); null -> "—". */
export function formatRating(avg: number | null): string {
  return avg === null ? "—" : (Math.round(avg * 10) / 10).toFixed(1);
}

/** "3 дні тому" style, coarse like the app's review cards. */
export function relativeUk(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.floor((now.getTime() - t) / 60000));
  if (mins < 60) return "щойно";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}${nbsp}${hours === 1 ? "годину" : hours < 5 ? "години" : "годин"} тому`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}${nbsp}${days === 1 ? "день" : days < 5 ? "дні" : "днів"} тому`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return weeks === 1 ? "тиждень тому" : `${weeks}${nbsp}${weeks < 5 ? "тижні" : "тижнів"} тому`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}${nbsp}${months === 1 ? "місяць" : months < 5 ? "місяці" : "місяців"} тому`;
  const years = Math.floor(days / 365);
  return years <= 1 ? "рік тому" : `${years}${nbsp}${years < 5 ? "роки" : "років"} тому`;
}

/** Fits a title into `max` chars: tries the parts from most to least specific, never cuts mid-word. */
export function fitTitle(max: number, ...candidates: string[]): string {
  for (const c of candidates) if (c.length <= max) return c;
  const last = candidates[candidates.length - 1] ?? "";
  const cut = last.slice(0, max - 1).replace(/\s+\S*$/, "");
  return `${cut || last.slice(0, max - 1)}…`;
}

/** Description of at most `max` chars, cut at a word boundary. */
export function fitDescription(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1).replace(/[\s,;:]+\S*$/, "");
  return `${cut}…`;
}

export interface ServiceGroup<T> {
  key: string;
  name: string;
  items: T[];
}

/** Groups services by `category` in the order of `categories` (the API's order); a service whose category is unknown goes last, unnamed key "". */
export function groupByCategory<T extends { category: string | null }>(items: T[], categories: { name: string; key: string | null }[], fallbackName: string): ServiceGroup<T>[] {
  const groups: ServiceGroup<T>[] = categories.map((c) => ({ key: c.key ?? c.name, name: c.name, items: [] }));
  const rest: T[] = [];
  for (const it of items) {
    const g = groups.find((x, i) => categories[i]!.key !== null && categories[i]!.key === it.category);
    if (g) g.items.push(it);
    else rest.push(it);
  }
  const out = groups.filter((g) => g.items.length > 0);
  if (rest.length) out.push({ key: "", name: fallbackName, items: rest });
  return out;
}

export type ReviewSort = "NEWEST" | "OLDEST" | "HIGHEST" | "LOWEST";
export const REVIEW_SORTS: ReviewSort[] = ["NEWEST", "OLDEST", "HIGHEST", "LOWEST"];
export const parseSort = (v: string | null): ReviewSort => (REVIEW_SORTS as string[]).includes(v ?? "") ? (v as ReviewSort) : "NEWEST";

/** Street line as the app builds it: "вул. Хрещатик, 22" (building omitted when absent). */
export function streetLine(street: string | null, building: string | null): string | null {
  const s = [street, building].filter(Boolean).join(", ");
  return s || null;
}

/** «5 зірок», «1 зірка», «2 зірки» (the bar labels of the rating distribution). */
export function pluralStars(n: number): string {
  const m100 = n % 100;
  const m10 = n % 10;
  const word = m100 >= 11 && m100 <= 14 ? "зірок" : m10 === 1 ? "зірка" : m10 >= 2 && m10 <= 4 ? "зірки" : "зірок";
  return `${n} ${word}`;
}
