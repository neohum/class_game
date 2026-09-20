// verify-deployment.ts — bounded post-deploy environment health verification.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { log } from "./telemetry.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the CLI asked for. Both fields are absent rather than empty when unset. */
export interface VerificationOptions {
  url?: string;
  stage?: string;
}

export interface VerificationResult {
  ok: boolean;
  attempts: number;
  skipped?: boolean;
  reason?: string;
  status?: number | null;
  error?: string;
}

export function verificationOptions(argv: string[] = [], env: NodeJS.ProcessEnv = process.env): VerificationOptions {
  const index = argv.indexOf("--url");
  const inline = argv.find((arg) => arg.startsWith("--url="));
  const url = index !== -1 ? argv[index + 1] : inline?.slice("--url=".length);
  const stageIndex = argv.indexOf("--stage");
  const stageInline = argv.find((arg) => arg.startsWith("--stage="));
  const stage = stageIndex !== -1 ? argv[stageIndex + 1] : stageInline?.slice("--stage=".length);
  return {
    ...(url ? { url } : (env.FACTORY_HEALTH_URL ? { url: env.FACTORY_HEALTH_URL } : {})),
    ...(stage ? { stage } : {}),
  };
}

export async function verifyDeployment({
  url = process.env.FACTORY_HEALTH_URL,
  attempts = Number(process.env.FACTORY_HEALTH_ATTEMPTS || 12),
  intervalMs = Number(process.env.FACTORY_HEALTH_INTERVAL_MS || 10_000),
  fetchImpl = fetch,
}: {
  url?: string;
  attempts?: number;
  intervalMs?: number;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>;
} = {}): Promise<VerificationResult> {
  if (!url) return { ok: true, skipped: true, reason: "FACTORY_HEALTH_URL is not configured", attempts: 0 };
  let lastStatus: number | null = null;
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
      lastStatus = response.status;
      if (response.ok) return { ok: true, attempts: attempt, status: response.status };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  return { ok: false, attempts, status: lastStatus, error: lastError };
}

const isMain = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const options = verificationOptions(process.argv.slice(2));
  const result = await verifyDeployment(options);
  await log(result.ok ? "health" : "error", {
    actor: `${options.stage || "production"}-health`,
    detail: result,
  }).catch(() => {});
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
