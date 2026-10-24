// The one serializer for JSON embedded in HTML (a <script type="application/ld+json">, a JSON data block, a data-* attribute).
// Plain JSON.stringify leaves "<" alone, so a value like "</script><img onerror=...>" (a review, a bio, a description) would end the
// script element and inject markup into a page the edge then caches. Every character that can end or reopen an HTML context is written
// as a \uXXXX escape: the result is still valid JSON and parses back to exactly the original strings.
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
