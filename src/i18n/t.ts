import uk from "./uk.json";

export const defaultLocale = "uk";
export const locales = ["uk"] as const;
export type Locale = (typeof locales)[number];

const dictionaries: Record<Locale, unknown> = { uk };

/**
 * Looks up a dot-path key (e.g. "index.h1") and interpolates `{name}` placeholders.
 * A missing key or placeholder throws, so a typo fails the build instead of shipping "undefined".
 */
export function t(key: string, vars: Record<string, string | number> = {}, locale: Locale = defaultLocale): string {
  let node: unknown = dictionaries[locale];
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object" || !(part in node)) {
      throw new Error(`i18n: missing key "${key}" for locale "${locale}"`);
    }
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== "string") {
    throw new Error(`i18n: key "${key}" is not a string for locale "${locale}"`);
  }
  return node.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!(name in vars)) throw new Error(`i18n: key "${key}" needs variable "{${name}}"`);
    return String(vars[name]);
  });
}
