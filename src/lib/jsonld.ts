// Typed JSON-LD builders (README § 9). Add new schema.org types here, never inline in pages.
export interface Crumb {
  name: string;
  /** Absolute URL. */
  url: string;
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
