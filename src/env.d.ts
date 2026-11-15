/// <reference types="astro/client" />

// `recap-row.ts?own` (guest cancel page): the same module bundled into that entry only (no shared chunk request); types come from the one source file.
declare module "*/recap-row.ts?own" {
  export const el: typeof import("./scripts/booking/recap-row").el;
  export const kvRow: typeof import("./scripts/booking/recap-row").kvRow;
  export const lrow: typeof import("./scripts/booking/recap-row").lrow;
}

// `duration.ts?own` (cancel page) and `duration.ts?ics` (ics-lines): private copies (distinct ids) inlined into their importing chunks, so the 155 B module is not a request of its own on the /c/ pages.
declare module "*/duration.ts?own" {
  export const KYIV: typeof import("./lib/booking/duration").KYIV;
  export const nbsp: typeof import("./lib/booking/duration").nbsp;
  export const formatDuration: typeof import("./lib/booking/duration").formatDuration;
}
declare module "*/duration.ts?ics" {
  export * from "*/duration.ts?own";
}
