#!/usr/bin/env node
// setup-typesafe-key.ts — walk a TYPESAFE_API_KEY from the console into .env,
// verify it against the live API, and optionally push it to Infisical.
//
// Key creation is console-only: TypeSafe exposes no endpoint that mints a key,
// so this script opens the page, takes the paste, and does every mechanical
// step around it. The key is read from a hidden prompt (or stdin), never from
// argv — a command-line argument lands in shell history and `ps` output.
//
//   node scripts/setup-typesafe-key.ts              # prompt, verify, write .env
//   node scripts/setup-typesafe-key.ts --push       # ...and push to Infisical
//   node scripts/setup-typesafe-key.ts --no-open    # don't open the browser
//   node scripts/setup-typesafe-key.ts --check      # only test the stored key
//   echo "sk-..." | node scripts/setup-typesafe-key.ts --stdin

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const CONSOLE_URL = "https://console.typesafe.ai/settings/keys";
const VERIFY_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const ENV_KEY = "TYPESAFE_API_KEY";
const ENV_PATH = resolve(process.cwd(), ".env");

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);

function say(msg = "") { console.log(msg); }
function warn(msg: string) { console.error(msg); }

/** Open a URL in the platform browser. Never fatal — the URL is printed too. */
function openBrowser(url: string): boolean {
  const [cmd, args] = process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a secret without echoing it.
 *
 * Falls back to a normal prompt when stdin is not a TTY (piped input), because
 * raw mode is unavailable there and a hard failure would be worse than an echo
 * the caller already controls.
 */
function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((res) => {
      const rl = createInterface({ input: process.stdin });
      rl.once("line", (line) => { rl.close(); res(line.trim()); });
    });
  }
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = process.stdout as NodeJS.WriteStream & { _writeToOutput?: (s: string) => void };
    // Mask everything after the prompt itself.
    let masking = false;
    const original = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (chunk: string) {
      if (!masking) { original.call(this, chunk); return; }
      if (chunk.includes("\n")) original.call(this, "\n");
    };
    process.stdout.write(question);
    masking = true;
    rl.question("", (answer) => {
      masking = false;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = original;
      rl.close();
      void output;
      res(answer.trim());
    });
  });
}

function ask(question: string): Promise<string> {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); res(a.trim()); });
  });
}

/** Obvious shape problems, caught before spending a network round trip. */
export function validateKeyShape(key: string): string | null {
  if (!key) return "빈 값입니다.";
  if (/\s/.test(key)) return "공백이 포함돼 있습니다. 따옴표 없이 키만 붙여넣으세요.";
  if (key.startsWith(`${ENV_KEY}=`)) return `"${ENV_KEY}=" 접두사를 빼고 값만 붙여넣으세요.`;
  if (/^["']|["']$/.test(key)) return "따옴표를 빼고 값만 붙여넣으세요.";
  if (key.length < 16) return "키가 너무 짧습니다. 전체를 복사했는지 확인하세요.";
  return null;
}

/**
 * Prove the key works by making the cheapest possible real call.
 *
 * A shape check cannot tell a revoked key from a live one, and finding out
 * during the eval — after it has burned half the case file — is worse than
 * finding out here.
 */
export async function verifyKey(key: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetchImpl(VERIFY_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        state: "ping",
        questions: { ok: { type: "noul", instructions: "This text is a greeting" } },
      }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      answers?: Record<string, unknown>; message?: string; error?: { message?: string };
    };
    if (res.status === 401 || res.status === 403) return { ok: false, detail: "인증 거부(401/403) — 키가 잘못됐거나 폐기됐습니다." };
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${data.error?.message || data.message || "알 수 없는 오류"}` };
    if (!data.answers) return { ok: false, detail: "응답에 answers가 없습니다 — 엔드포인트 스키마가 바뀌었을 수 있습니다." };
    return { ok: true, detail: "실제 호출 성공(answers 수신)." };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return { ok: false, detail: aborted ? "15초 안에 응답 없음(타임아웃)." : `요청 실패: ${(error as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Set KEY=value in a .env body, replacing an existing line in place.
 *
 * Returns the new text plus what happened, so the caller can tell the user
 * whether it replaced something rather than silently clobbering a live key.
 */
export function upsertEnvLine(body: string, key: string, value: string): { text: string; replaced: boolean } {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(body)) return { text: body.replace(re, line), replaced: true };
  const sep = body.length === 0 || body.endsWith("\n") ? "" : "\n";
  return { text: `${body}${sep}${line}\n`, replaced: false };
}

/** Read the key currently stored in .env, if any. */
export function readStoredKey(envPath = ENV_PATH): string | null {
  if (!existsSync(envPath)) return null;
  const m = new RegExp(`^${ENV_KEY}=(.*)$`, "m").exec(readFileSync(envPath, "utf8"));
  return m?.[1]?.trim() || null;
}

/** Never print a secret in full, not even to a local terminal. */
export function maskKey(key: string): string {
  if (key.length <= 10) return "*".repeat(key.length);
  return `${key.slice(0, 6)}…${key.slice(-4)} (${key.length}자)`;
}

async function main(): Promise<number> {
  say("TypeSafe API 키 설정 — Jev 판정 레이어용");
  say("=".repeat(52));

  // --check: verify what is already stored and stop.
  if (has("--check")) {
    const stored = readStoredKey();
    if (!stored) { warn(`\n.env에 ${ENV_KEY}가 없습니다.`); return 1; }
    say(`\n저장된 키: ${maskKey(stored)}`);
    say("검증 중…");
    const v = await verifyKey(stored);
    say(v.ok ? `✓ ${v.detail}` : `✗ ${v.detail}`);
    return v.ok ? 0 : 1;
  }

  const existing = readStoredKey();
  if (existing) {
    say(`\n⚠ .env에 이미 ${ENV_KEY}가 있습니다: ${maskKey(existing)}`);
    const answer = await ask("덮어쓸까요? [y/N] ");
    if (!/^y(es)?$/i.test(answer)) { say("취소했습니다. 기존 키를 그대로 둡니다."); return 0; }
  }

  let key: string;
  if (has("--stdin")) {
    key = await promptSecret("");
  } else {
    say(`\n1) 키 발급 페이지를 엽니다:\n   ${CONSOLE_URL}`);
    if (!has("--no-open")) {
      openBrowser(CONSOLE_URL);
      say("   (브라우저가 안 열리면 위 주소를 직접 여세요)");
    }
    say("\n2) 'Create key'로 키를 만들고 복사한 뒤 아래에 붙여넣으세요.");
    say("   입력은 화면에 표시되지 않습니다. 붙여넣고 Enter.\n");
    key = await promptSecret(`${ENV_KEY}: `);
    say();
  }

  const shapeError = validateKeyShape(key);
  if (shapeError) { warn(`✗ ${shapeError}`); return 1; }

  say(`입력받은 키: ${maskKey(key)}`);
  say("실제 API로 검증 중…");
  const verified = await verifyKey(key);
  if (!verified.ok) {
    warn(`✗ ${verified.detail}`);
    warn("\n키를 저장하지 않았습니다. 콘솔에서 키를 다시 확인해 주세요.");
    return 1;
  }
  say(`✓ ${verified.detail}`);

  // Write .env. It is gitignored, so this never reaches a commit.
  const body = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const { text, replaced } = upsertEnvLine(body, ENV_KEY, key);
  writeFileSync(ENV_PATH, text, "utf8");
  say(`✓ .env에 ${replaced ? "갱신" : "추가"}했습니다 (.env는 gitignore 대상).`);

  if (has("--push")) {
    say("\nInfisical로 푸시 중…");
    const r = spawnSync(process.execPath, [resolve(process.cwd(), "scripts", "env-sync.ts"), "push"], {
      encoding: "utf8", stdio: "inherit",
    });
    if (r.status !== 0) {
      warn("\n⚠ 푸시 실패. INFISICAL_TOKEN 또는 INFISICAL_CLIENT_ID/_SECRET이 필요합니다.");
      warn("  키는 .env에 안전하게 저장돼 있으니, 인증 설정 후 다시 실행하세요:");
      warn("    node scripts/env-sync.ts push");
    }
  } else {
    say("\nInfisical에 올리려면:  node scripts/env-sync.ts push");
  }

  say("\n다음 단계 — Jev 실측 (계획서가 정한 순서):");
  say("  node scripts/jev-risk-eval.ts --split dev       # 질문 문구 다듬기");
  say("  node scripts/jev-risk-eval.ts --split holdout   # 문구 고정 후 1회만");
  say("\n켜는 조건(측정 전 고정): 거짓 음성 절반 이하 감소 AND 거짓 양성 2건 이하 증가.");
  return 0;
}

const isMain = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`설정 실패: ${(error as Error).message}`);
    process.exit(1);
  });
}
