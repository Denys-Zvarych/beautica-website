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

/** Logs name/code/message/stack of an unexpected error. Never the request body: no user data. */
function logError(what: string, err: unknown): void {
  const e = err as { name?: string; code?: string; message?: string; stack?: string } | undefined;
  console.error(`delete-request: ${what}`, e?.name, e?.code, e?.message, e?.stack);
}

export const POST: APIRoute = async ({ request }) => {
  const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
  try {
    return await handle(request, wantsJson);
  } catch (err) {
    logError("unexpected", err);
    return reply(wantsJson, 500, { ok: false, error: "internal" }, "error");
  }
};

async function handle(request: Request, wantsJson: boolean): Promise<Response> {
  const b = env as unknown as Partial<Bindings>;

  // Same-origin only (browsers always send Origin on form POST); non-browser clients without Origin are allowed.
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return reply(wantsJson, 403, { ok: false, error: "forbidden" }, "error");
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) {
    return reply(wantsJson, 413, { ok: false, error: "too_large" }, "error");
  }

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  // A missing or failing limiter must not take the form down (Turnstile-less, but the honeypot and size cap remain).
  if (b.DELETION_LIMITER) {
    try {
      const { success } = await b.DELETION_LIMITER.limit({ key: ip });
      if (!success) {
        console.info("delete-request: rate-limited");
        return reply(wantsJson, 429, { ok: false, error: "rate_limited" }, "error");
      }
    } catch (err) {
      logError("rate limiter failed, continuing", err);
    }
  } else {
    console.warn("delete-request: DELETION_LIMITER binding missing, continuing without rate limit");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(wantsJson, 400, { ok: false, error: "invalid" }, "error");
  }

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
    return reply(wantsJson, 502, { ok: false, error: "send_failed" }, "error");
  }
  console.info("delete-request: sent");
  return reply(wantsJson, 200, { ok: true }, "sent");
}

export const ALL: APIRoute = () =>
  new Response(null, { status: 405, headers: { ...baseHeaders, Allow: "POST" } });
