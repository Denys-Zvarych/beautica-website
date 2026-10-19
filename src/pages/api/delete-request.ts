// POST /api/delete-request: emails an account-deletion request to the team (phase 011). On-demand (Worker), the rest of the
// site stays static. No data is stored or logged: only a success/failure counter line.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";
import { MAIL_FROM, MAIL_TO, buildMime, validate } from "../../lib/deleteRequest";

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

export const POST: APIRoute = async ({ request }) => {
  const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
  const b = env as unknown as Bindings;

  // Same-origin only (browsers always send Origin on form POST); non-browser clients without Origin are allowed.
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return reply(wantsJson, 403, { ok: false, error: "forbidden" }, "error");
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) {
    return reply(wantsJson, 413, { ok: false, error: "too_large" }, "error");
  }

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await b.DELETION_LIMITER.limit({ key: ip });
  if (!success) {
    console.info("delete-request: rate-limited");
    return reply(wantsJson, 429, { ok: false, error: "rate_limited" }, "error");
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

  try {
    await b.DELETION_MAIL.send(new EmailMessage(MAIL_FROM, MAIL_TO, buildMime(result.value)));
  } catch {
    console.error("delete-request: send failed");
    return reply(wantsJson, 502, { ok: false, error: "send_failed" }, "error");
  }
  console.info("delete-request: sent");
  return reply(wantsJson, 200, { ok: true }, "sent");
};

export const ALL: APIRoute = () =>
  new Response(null, { status: 405, headers: { ...baseHeaders, Allow: "POST" } });
