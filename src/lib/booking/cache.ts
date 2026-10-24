// Edge-cache policy of the link pages. Pure (unit-tested).
const DEFAULT_TTL = 30;

/** s-maxage of the upstream response (the backend bounds staleness at 30 s on purpose), never below 1 s. */
export function upstreamTtl(cacheControl: string | null): number {
  const m = /s-maxage=(\d+)/i.exec(cacheControl ?? "");
  return m ? Math.max(1, Number(m[1])) : DEFAULT_TTL;
}
