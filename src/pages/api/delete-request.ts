// POST /api/delete-request: emails an account-deletion request to the team (phase 011). On-demand (Worker), the rest of the
// site stays static. No submitted data is stored or logged: only a status line (and the send error name/code/message).
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { buildMessage, validate } from "../../lib/deleteRequest";

export const prerender = false;

const MAX_BODY = 8 * 1024;

interface Bindings {
  DELETION_MAIL: { send(message: unknown): Promise<unknown> };
  DELETION_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const baseHeaders = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

function reply(wantsJson: boolean, status: number, body: Record<string, unknown>, redirect: "sent" | "error"): Response {
  if (wantsJson) return Response.json(body, { status, headers: baseHeaders });
  return new Response(null, { status: 303, headers: { ...baseHeaders, Location: `/delete-account?${redirect}=1` } });
}

/** Logs the error name and code, plus the message only when it holds no "@" (a send error could echo an address).
 *  Never the stack of a send error and never the request body: no user data. */
function logError(what: string, err: unknown, withStack = false): void {
  const e = err as { name?: string; code?: string; message?: string; stack?: string } | undefined;
  const message = typeof e?.message === "string" && !e.message.includes("@") ? e.message : undefined;
  console.error(`delete-request: ${what}`, e?.name, e?.code, message, withStack && typeof e?.stack === "string" && !e.stack.includes("@") ? e.stack : undefined);
}

/** Same origin as the request URL; a malformed Origin ("null", garbage) counts as foreign. */
function isSameOrigin(origin: string, requestUrl: string): boolean {
  try {
    return new URL(origin).host === new URL(requestUrl).host;
  } catch {
    return false;
  }
}

export const POST: APIRoute = async ({ request }) => {
  const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
  try {
    return await handle(request, wantsJson);
  } catch (err) {
    logError("unexpected", err, true);
    return reply(wantsJson, 500, { ok: false, error: "internal" }, "error");
  }
};

/** Reads the body through a counting stream: null = more than MAX_BODY bytes (Content-Length can be absent or a lie, e.g. chunked). */
async function readCapped(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) (out.set(c, at), (at += c.byteLength));
  return out;
}

/** true = over the limit. A missing or failing limiter counts as "not limited" (fail-open on purpose: the form must not go down
 *  with the limiter; the honeypot and the size cap remain). Both paths log the same distinct, PII-free warning. */
async function checkLimit(b: Partial<Bindings>, ip: string): Promise<boolean> {
  if (!b.DELETION_LIMITER) {
    console.warn("delete-request: rate limiter unavailable");
    return false;
  }
  try {
    return !(await b.DELETION_LIMITER.limit({ key: ip })).success;
  } catch (err) {
    console.warn("delete-request: rate limiter unavailable");
    logError("rate limiter failed, continuing", err);
    return false;
  }
}

async function handle(request: Request, wantsJson: boolean): Promise<Response> {
  const b = env as unknown as Partial<Bindings>;

  // Same-origin only (browsers always send Origin on form POST); non-browser clients without Origin are allowed.
  const origin = request.headers.get("origin");
  if (origin && !isSameOrigin(origin, request.url)) {
    return reply(wantsJson, 403, { ok: false, error: "forbidden" }, "error");
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) {
    return reply(wantsJson, 413, { ok: false, error: "too_large" }, "error");
  }

  // The limiter check and the body parse are independent: run them together, then decide (the send below stays awaited).
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  // A missing or failing limiter must not take the form down (Turnstile-less, but the honeypot and size cap remain).
  const limited = checkLimit(b, ip);
  const bodyRead = readCapped(request).then(
    (read) => read,
    () => undefined,
  );
  if (await limited) {
    console.info("delete-request: rate-limited");
    return reply(wantsJson, 429, { ok: false, error: "rate_limited" }, "error");
  }
  const bytes = await bodyRead;
  if (bytes === null) return reply(wantsJson, 413, { ok: false, error: "too_large" }, "error");
  const form = bytes
    ? await new Response(bytes, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData().then(
        (f) => f,
        () => null,
      )
    : null;
  if (!form) return reply(wantsJson, 400, { ok: false, error: "invalid" }, "error");

  // Honeypot: bots fill the hidden field. Pretend success, send nothing.
  if (typeof form.get("website") === "string" && (form.get("website") as string).trim() !== "") {
    console.info("delete-request: honeypot");
    return reply(wantsJson, 200, { ok: true }, "sent");
  }

  const result = validate(form);
  if (!result.ok) return reply(wantsJson, 422, { ok: false, error: "invalid", fields: result.fields }, "error");

  if (!b.DELETION_MAIL) {
    console.error("delete-request: DELETION_MAIL binding missing");
    return reply(wantsJson, 502, { ok: false, error: "send_failed" }, "error");
  }
  try {
    await b.DELETION_MAIL.send(buildMessage(result.value));
  } catch (err) {
    // Cloudflare puts only our own sender/inbox addresses in the message, never the submitted fields.
    logError("send failed", err);
    const e = err as { name?: unknown; code?: unknown } | undefined;
    const code = typeof e?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(e.code) ? e.code : null;
    const name = typeof e?.name === "string" && /^[A-Za-z]{1,64}$/.test(e.name) ? e.name : null;
    return reply(wantsJson, 502, { ok: false, error: "send_failed", code, name }, "error");
  }
  console.info("delete-request: sent");
  return reply(wantsJson, 200, { ok: true }, "sent");
}

export const ALL: APIRoute = () =>
  new Response(null, { status: 405, headers: { ...baseHeaders, Allow: "POST" } });
