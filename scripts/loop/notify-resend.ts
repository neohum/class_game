// notify-resend.ts — email factory digests through the Resend HTTP API.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { log } from "./telemetry.ts";

export function resendConfig(env = process.env) {
  const fields = {
    apiKey: env.RESEND_API_KEY,
    from: env.FACTORY_EMAIL_FROM,
    to: env.FACTORY_EMAIL_TO,
  };
  const missing = [];
  if (!fields.apiKey) missing.push("RESEND_API_KEY");
  if (!fields.from) missing.push("FACTORY_EMAIL_FROM");
  if (!fields.to) missing.push("FACTORY_EMAIL_TO");
  return { ...fields, missing, ready: missing.length === 0 };
}

export async function notifyFactory({ subject, text, html, fetchImpl = fetch }: {
  subject?: string;
  text?: string;
  html?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<{ id?: string } & Record<string, unknown>> {
  const cfg = resendConfig();
  if (!cfg.ready) throw new Error(`missing required env: ${cfg.missing.join(", ")}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let response;
  try {
    response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: cfg.from,
        to: String(cfg.to ?? "").split(",").map((x) => x.trim()).filter(Boolean),
        subject: subject || "[Harness Factory] cycle report",
        text: text || "",
        ...(html ? { html } : {}),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const data = (await response.json().catch(() => ({}))) as { id?: string; message?: string } & Record<string, unknown>;
  if (!response.ok) throw new Error(`Resend request failed: ${data.message || response.status}`);
  await log("iterate", { actor: "resend", detail: { id: data.id, subject } }).catch(() => {});
  return data;
}

const isMain = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const [subject, ...parts] = process.argv.slice(2);
  notifyFactory({ subject, text: parts.join(" ") })
    .then((x) => console.log(x.id || "sent"))
    .catch((error) => { console.error(error.message); process.exit(1); });
}
