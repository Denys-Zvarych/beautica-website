// Typed JSON-LD builders (README § 9). Add new schema.org types here, never inline in pages.
export interface Crumb {
  name: string;
  /** Absolute URL. */
  url: string;
}

export interface OrganizationInput {
  name: string;
  /** Absolute site URL. */
  url: string;
  /** Absolute logo URL. */
  logo: string;
  /** Real public profiles only; omitted when empty. */
  sameAs?: string[];
}

export function organization(o: OrganizationInput): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${o.url}#organization`,
    name: o.name,
    url: o.url,
    logo: o.logo,
    ...(o.sameAs && o.sameAs.length > 0 ? { sameAs: o.sameAs } : {}),
  };
}

/** No SearchAction: the site has no search. */
export function webSite(o: { name: string; url: string; inLanguage: string }): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${o.url}#website`,
    name: o.name,
    url: o.url,
    inLanguage: o.inLanguage,
    publisher: { "@id": `${o.url}#organization` },
  };
}

export function breadcrumbList(crumbs: Crumb[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: c.url,
    })),
  };
}

// ---- Booking-link pages (phases 008/009). Ratings and reviews only when they are visibly rendered on the page. ----
export interface ProfileOffer {
  name: string;
  /** "From" price in UAH; absent when the page only knows a display string. */
  priceFrom?: number;
}
export interface ProfileReview {
  author: string;
  rating: number;
  text: string | null;
  /** ISO date-time. */
  published: string;
}
export interface ProfileInput {
  /** Absolute canonical URL. */
  url: string;
  name: string;
  /** Absolute https image URL. */
  image?: string | null;
  description?: string | null;
  jobTitle?: string | null;
  address: { locality?: string | null; region?: string | null; street?: string | null };
  offers: ProfileOffer[];
  /** Only for a page that renders the reviews. */
  rating?: { value: number; count: number } | null;
  reviews?: ProfileReview[];
}

export function profileBusiness(p: ProfileInput): Record<string, unknown> {
  const a = p.address;
  const hasAddress = !!(a.locality || a.region || a.street);
  return {
    "@context": "https://schema.org",
    "@type": "HealthAndBeautyBusiness",
    "@id": `${p.url}#business`,
    name: p.name,
    url: p.url,
    ...(p.image ? { image: p.image } : {}),
    ...(p.description ? { description: p.description } : {}),
    ...(hasAddress
      ? {
          address: {
            "@type": "PostalAddress",
            addressCountry: "UA",
            ...(a.locality ? { addressLocality: a.locality } : {}),
            ...(a.region ? { addressRegion: a.region } : {}),
            ...(a.street ? { streetAddress: a.street } : {}),
          },
        }
      : {}),
    ...(p.offers.length > 0
      ? {
          makesOffer: p.offers.map((o) => ({
            "@type": "Offer",
            itemOffered: { "@type": "Service", name: o.name },
            ...(o.priceFrom !== undefined ? { priceSpecification: { "@type": "PriceSpecification", minPrice: o.priceFrom, priceCurrency: "UAH" } } : {}),
          })),
        }
      : {}),
    ...(p.rating && p.rating.count > 0
      ? { aggregateRating: { "@type": "AggregateRating", ratingValue: p.rating.value, reviewCount: p.rating.count, bestRating: 5, worstRating: 1 } }
      : {}),
    ...(p.reviews && p.reviews.length > 0
      ? {
          review: p.reviews.map((r) => ({
            "@type": "Review",
            author: { "@type": "Person", name: r.author },
            reviewRating: { "@type": "Rating", ratingValue: r.rating, bestRating: 5, worstRating: 1 },
            ...(r.text ? { reviewBody: r.text } : {}),
            ...(r.published ? { datePublished: r.published } : {}),
          })),
        }
      : {}),
  };
}
