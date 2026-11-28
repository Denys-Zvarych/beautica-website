// Pure formatting of Workers Builds events (no Cloudflare imports). Phase 053, spec WEB-72.
export const ALERT_TYPES = ["cf.workersBuilds.worker.build.failed", "cf.workersBuilds.worker.build.canceled"];
export const MAIL_FROM = "noreply@beautica.app";
export const MAIL_TO = "beautica.ua@gmail.com";

const DASH = "—";
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
// Header-safe single line: control chars (CR/LF included) collapse to a space.
const line = (v, max) => str(v).replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
const ID_RE = /^[0-9a-f-]{32,36}$/i;
const WORKER_RE = /^[\w-]{1,63}$/;

/** @returns {{ subject: string, text: string, buildUuid: string } | null} */
export function toAlert(event) {
  if (!event || typeof event !== "object" || !ALERT_TYPES.includes(event.type)) return null;
  const workerName = line(event.source?.workerName, 100);
  const p = event.payload ?? {};
  const buildUuid = str(p.buildUuid);
  if (!workerName || !buildUuid) return null;

  const failed = event.type.endsWith(".failed");
  const m = p.buildTriggerMetadata ?? {};
  const branch = line(m.branch, 100);
  const env = branch === "main" ? "прод" : "прев'ю/стейджинг";
  const hash = str(m.commitHash).slice(0, 7);
  const firstLine = str(m.commitMessage).split(/\r?\n/)[0].trim().slice(0, 100);
  const commit = hash || firstLine ? `${hash || DASH} ${firstLine || DASH}` : DASH;

  const accountId = str(event.metadata?.accountId);
  const linkOk = ID_RE.test(accountId) && ID_RE.test(buildUuid) && WORKER_RE.test(workerName);
  const base = linkOk ? `https://dash.cloudflare.com/${accountId}/workers/services/view/${workerName}/production` : "";
  const link = base ? `${base}/builds/${buildUuid}` : DASH;

  const subject = `[Beautica] ${failed ? "Збірка впала" : "Збірку скасовано"}: ${workerName} @ ${branch || DASH}`.slice(0, 200);
  const text = [
    `Worker: ${workerName}`,
    `Гілка: ${branch || DASH} (${branch ? env : DASH})`,
    `Коміт: ${commit}`,
    `Запуск: ${str(m.buildTriggerSource) || DASH}`,
    `Зупинено: ${str(p.stoppedAt) || DASH}`,
    `Збірка: ${link}`,
    `buildUuid: ${buildUuid}`,
  ].join("\n");
  return { subject, text, buildUuid };
}
