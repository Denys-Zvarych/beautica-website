/// <reference types="astro/client" />

// `recap-row.ts?own` (guest cancel page): the same module bundled into that entry only (no shared chunk request); types come from the one source file.
declare module "*/recap-row.ts?own" {
  export const el: typeof import("./scripts/booking/recap-row").el;
  export const kvRow: typeof import("./scripts/booking/recap-row").kvRow;
  export const lrow: typeof import("./scripts/booking/recap-row").lrow;
}
