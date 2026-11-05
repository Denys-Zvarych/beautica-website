// Two-colour-or-more calendar marks (24x24 inner SVG markup) for the «Додати в календар» chooser. Own simplified drawings in the spirit of the Google Calendar
// and Apple Calendar app icons (no official artwork is copied); trademarks belong to Google LLC / Apple Inc. Inline only: no requests. Shared by the Icon
// component (names "google-calendar", "apple-calendar") and the booking island, which builds the same nodes at run time.
export const brandMarks = {
  "google-calendar":
    '<path fill="#fff" d="M7 7h10v10H7z"/><path fill="#4285F4" d="M5 3h9v4H7v10H3V5a2 2 0 0 1 2-2z"/><path fill="#EA4335" d="M14 3h5a2 2 0 0 1 2 2v2h-7z"/><path fill="#FBBC04" d="M17 7h4v10h-4z"/><path fill="#34A853" d="M3 17h14v4H5a2 2 0 0 1-2-2z"/><path fill="#1967D2" d="M17 17h4v2a2 2 0 0 1-2 2h-2z"/><path fill="#4285F4" d="M9 10h6v1.6H9zM9 13.4h4v1.6H9z"/>',
  "apple-calendar":
    '<rect x="3" y="3" width="18" height="18" rx="4.5" fill="#fff" stroke="#00000026" stroke-width=".6"/><path fill="#FF3B30" d="M7.5 3h9A4.5 4.5 0 0 1 21 7.5V9H3V7.5A4.5 4.5 0 0 1 7.5 3z"/><path fill="#4A3322" d="M8 12h8v1.8H8zM8 15.4h5v1.8H8z"/>',
} as const;
export type BrandMark = keyof typeof brandMarks;
