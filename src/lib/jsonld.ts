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
