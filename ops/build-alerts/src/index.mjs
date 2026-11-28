import { MAIL_FROM, MAIL_TO, toAlert } from "./format.mjs";

export default {
  async queue(batch, env) {
    // Concurrent sends; each message is acked or retried on its own outcome.
    await Promise.allSettled(
      batch.messages.map(async (msg) => {
        const alert = toAlert(msg.body);
        if (!alert) {
          msg.ack(); // unknown or unparseable: never retried
          return;
        }
        try {
          await env.ALERT_MAIL.send({ from: MAIL_FROM, to: MAIL_TO, subject: alert.subject, text: alert.text });
          msg.ack();
        } catch {
          console.error("build-alert send failed", alert.buildUuid);
          msg.retry();
        }
      }),
    );
  },
};
