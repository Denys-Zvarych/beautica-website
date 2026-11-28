// W052 (D9): the admin navigation is data. A future section («Скарги») is one more object here; the shell renders whatever this holds.
export interface AdminNavItem { href: string; labelKey: string; icon: "dashboard" | "inbox" | "category"; longKey?: string }
export type AdminNavNode = { items: AdminNavItem[]; titleKey?: undefined; id?: undefined } | { id: string; titleKey: string; items: AdminNavItem[] };

export const ADMIN_NAV: AdminNavNode[] = [
  { items: [{ href: "/admin", labelKey: "admin.nav.overview", icon: "dashboard" }] },
  { id: "categories", titleKey: "admin.nav.categories", items: [
    { href: "/admin/requests", labelKey: "admin.nav.requests", longKey: "admin.nav.requestsLong", icon: "inbox" },
    { href: "/admin/catalog", labelKey: "admin.nav.catalog", longKey: "admin.nav.catalogLong", icon: "category" },
  ] },
];
