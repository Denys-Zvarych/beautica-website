import { defineCollection } from "astro:content";
import { readdirSync, readFileSync } from "node:fs";
import { z } from "astro/zod";
import { applyLegalVars } from "./config/legal.mjs";

/**
 * "## Заголовок {#guest}" -> plain "## Заголовок" plus the list of h2 headings (id + text) for the table of contents;
 * the explicit ids (stable, linkable; Cyrillic auto-slugs are not) are applied to the rendered HTML by withExplicitIds.
 */
function withHeadingIds(markdown: string): { markdown: string; headings: { depth: number; slug: string; text: string }[] } {
  const headings: { depth: number; slug: string; text: string }[] = [];
  const out = markdown.replace(/^## (.+?) \{#([a-z][\w-]*)\}\s*$/gm, (_, text: string, slug: string) => {
    headings.push({ depth: 2, slug, text });
    return `## ${text}`;
  });
  return { markdown: out, headings };
}

function withExplicitIds(html: string, headings: { slug: string }[]): string {
  // Matched by position, not text: smart punctuation rewrites quotes/apostrophes in the rendered heading text.
  let i = 0;
  const out = html.replace(/<h2 id="[^"]*">/g, () => `<h2 id="${headings[i++]?.slug ?? ""}">`);
  if (i !== headings.length) throw new Error(`legal: ${headings.length} headings with ids, ${i} rendered <h2>`);
  // Every text link gets the animated underline label (.vt-u, base.css), like links in the header/footer.
  return out.replace(/(<a [^>]*>)([^<]+)(<\/a>)/g, '$1<span class="vt-u">$2</span>$3');
}

/** Minimal frontmatter reader for our own files: `key: value` lines, values either "double-quoted" (JSON string) or bare. */
function parseFrontmatter(source: string): { data: Record<string, string>; body: string } {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error("legal: file has no frontmatter");
  const data: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) throw new Error(`legal: cannot parse frontmatter line "${line}"`);
    const raw = kv[2]!.trim();
    data[kv[1]!] = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
  }
  return { data, body: m[2]! };
}

// Legal documents (Ukrainian today; EN later under src/content/legal/en/). One Markdown file per document.
// A small custom loader (instead of glob) so {{tokens}} are substituted before the Markdown is rendered.
const legal = defineCollection({
  loader: {
    name: "legal-markdown",
    load: async ({ store, parseData, renderMarkdown, generateDigest, config }) => {
      store.clear();
      const dir = new URL("./content/legal/", config.srcDir);
      for (const locale of readdirSync(dir)) {
        for (const file of readdirSync(new URL(`${locale}/`, dir)).filter((f) => f.endsWith(".md"))) {
          const id = `${locale}/${file.replace(/\.md$/, "")}`;
          const source = readFileSync(new URL(`${locale}/${file}`, dir), "utf8");
          const { data, body } = parseFrontmatter(source);
          const parsed = await parseData({ id, data });
          const { markdown, headings } = withHeadingIds(applyLegalVars(body));
          const rendered = await renderMarkdown(markdown);
          rendered.html = withExplicitIds(rendered.html, headings);
          rendered.metadata = { ...rendered.metadata, headings };
          store.set({ id, data: parsed, body, digest: generateDigest(applyLegalVars(source)), rendered });
        }
      }
    },
  },
  schema: z.object({
    title: z.string(),
    /** <title> (Seo enforces <= 60) and meta description (<= 155). */
    metaTitle: z.string(),
    description: z.string(),
    version: z.string(),
    /** ISO date the current version takes effect ("Дата набрання чинності"); an optional ".N" revision suffix is dropped for display. */
    updated: z.string().regex(/^\d{4}-\d{2}-\d{2}(\.\d{1,3})?$/).transform((s) => new Date(s.slice(0, 10))), // YYYY-MM-DD[.N]: the policy version the guest consent records
    locale: z.enum(["uk"]),
  }),
});

export const collections = { legal };
