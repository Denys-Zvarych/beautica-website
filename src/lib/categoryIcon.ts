// Category display name -> icon file under /icons. The public API sends a category id + name only, no slug, so the app's
// slug stage (category_icons.dart `_fromKey`) is replaced by an exact match on the live platform_categories display names
// (backend V74/V75), then the app's keyword stage (`_fromName`). Unknown names get the cosmetology glyph, like the app.
const exact: Record<string, string> = {
  "перукарські послуги": "hairdressing",
  "нігтьовий сервіс": "nail_service",
  "нарощення вій": "lash_extensions",
  "оформлення брів": "brows",
  "макіяж": "makeup",
  "подологія": "podology",
  "барберінг": "barbering",
  "борода та вуса": "beard_care",
  "фарбування волосся": "hair_coloring",
  "відновлення волосся": "hair_treatment",
  "нарощування волосся": "hair_extensions",
  "трихологія": "trichology",
  "ламінування вій": "lash_lamination",
  "косметологія": "cosmetology",
  "апаратна косметологія": "hardware_cosmetology",
  "естетична косметологія": "aesthetic_cosmetology",
  "лазерна косметологія": "laser_cosmetology",
  "депіляція та епіляція": "hair_removal",
  "перманентний макіяж": "permanent_makeup",
  "масаж і догляд за тілом": "body_massage",
};
const rules: [RegExp[], string][] = [
  [[/манікюр/], "nail_service"],
  [[/педикюр/], "podology"],
  [[/бров/], "brows"],
  [[/ламінування/, /вій/], "lash_lamination"],
  [[/вій|lash/], "lash_extensions"],
  [[/перманентн/], "permanent_makeup"],
  [[/макіяж/], "makeup"],
  [[/фарбування/], "hair_coloring"],
  [[/відновлення/, /волос/], "hair_treatment"],
  [[/нарощування/, /волос/], "hair_extensions"],
  [[/трихолог/], "trichology"],
  [[/барбер/], "barbering"],
  [[/борода|вуса/], "beard_care"],
  [[/волос|стриж/], "hairdressing"],
  [[/апаратна/], "hardware_cosmetology"],
  [[/ін['’]єкційна/], "injection_cosmetology"],
  [[/естетична/], "aesthetic_cosmetology"],
  [[/лазерна/], "laser_cosmetology"],
  [[/косметол/], "cosmetology"],
  [[/депіляц|епіляц/], "hair_removal"],
  [[/масаж/], "body_massage"],
];

const KNOWN_KEYS = new Set(Object.values(exact));

/** Prefer the category key (the app's slug stage), then the display name. */
export function categoryIconFor(name: string, key?: string | null): string {
  const k = key?.toLowerCase();
  return k && KNOWN_KEYS.has(k) ? `/icons/category_${k}.svg` : categoryIconUrl(name);
}

export function categoryIconUrl(name: string): string {
  const lower = name.trim().toLowerCase();
  if (Object.hasOwn(exact, lower)) return `/icons/category_${exact[lower]}.svg`;
  const hit = rules.find(([res]) => res.every((re) => re.test(lower)));
  return `/icons/category_${hit ? hit[1] : "cosmetology"}.svg`;
}
