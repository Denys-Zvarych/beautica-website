// Single definition of "gz size" for the JS budget (README § 4: <= 20 KB gz): gzip level 9 of the response BODY, no headers.
import { gzipSync } from "node:zlib";

export const gzSize = (body) => gzipSync(body, { level: 9 }).length;

// Sum of gz body sizes of the URLs, each pathname counted once (fetched from the running server).
export async function gzSizeOfUrls(urls) {
  const byPath = new Map();
  for (const u of urls) { const p = new URL(u).pathname; if (!byPath.has(p)) byPath.set(p, u); }
  let total = 0;
  for (const u of byPath.values()) total += gzSize(Buffer.from(await (await fetch(u)).arrayBuffer()));
  return total;
}
