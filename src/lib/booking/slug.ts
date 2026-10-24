// Slug format of the backend (PublicBookingController @Pattern + @Size(2..60)): validated before any fetch, so a malformed
// value never costs a backend call and is a clean 404.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === "string" && slug.length >= 2 && slug.length <= 60 && SLUG_RE.test(slug);
}
