// telegram-listener.mjs — long-poll daemon that reacts to inline-button taps.
//
// notify-telegram.mjs sends a build report with three buttons; this daemon is
// the other half. It long-polls getUpdates and dispatches each callback_query:
//
//   approve:<card>  spawn the deploy script (detached) so the listener never blocks
//   reject:<card>   write .harness/reject/<card>.json — ralph-loop.mjs watches that
//                   path and re-injects the error context to resume the iteration
//   logs:<card>     reply with the tail of current.md (the live action trail)
//
// After every tap we call answerCallbackQuery so Telegram stops the button's
// loading spinner. The poll loop runs forever, each iteration wrapped in
// try/catch with a short backoff so a transient network error never kills it.
//
// No external dependency — built-in global fetch (Node >= 18).
//
// Required env (validated; missing ones are listed before we exit):
//   TELEGRAM_BOT_TOKEN  bot token from @BotFather
//   TELEGRAM_CHAT_ID    chat/channel id we listen on

import { resolve, dirname } from "node:path";
import { mkdirSync, writeFileSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { log } from "./telemetry.mjs";
import { getBacklog } from "./backlog.mjs";
import { recordLabel } from "./persona-feedback.mjs";

function runCmd(bin, args = [], cwd = process.cwd()) {
  return new Promise((res) => {
    const child = spawn(bin, args, {
      cwd,
      shell: process.platform === "win32",
    });
    let stdout = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stdout += d.toString(); });
    child.on("exit", (code) => res({ code: code ?? 1, stdout }));
  });
}

const ROOT = resolve(process.cwd());
const REJECT_DIR = resolve(ROOT, ".harness", "reject");
const CURRENT_MD = resolve(ROOT, "current.md");
// fileURLToPath, not new URL(...).pathname — the latter yields "/E:/..%20.." on
// Windows and won't resolve to a real path.
const DEPLOY_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "deploy-railway.mjs");
const POLL_TIMEOUT = 50; // seconds — Telegram long-poll window
const BACKOFF_MS = 3000; // wait this long after a failed poll iteration

function requireEnv() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const missing = [];
  if (!token) missing.push("TELEGRAM_BOT_TOKEN");
  if (!chatId) missing.push("TELEGRAM_CHAT_ID");
  if (missing.length) {
    console.error(`missing required env: ${missing.join(", ")}`);
    process.exit(2);
  }
  return { token, chatId };
}

const api = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

async function answerCallback(token, callbackQueryId, text) {
  try {
    await fetch(api(token, "answerCallbackQuery"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch { /* spinner cleanup is best-effort */ }
}

async function sendMessage(token, chatId, text) {
  try {
    await fetch(api(token, "sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch { /* best-effort reply */ }
}

// Read only the last ~16KB rather than slurping the whole file — current.md is
// append-only and unbounded over a long-running server's lifetime.
function tailCurrentMd(maxLines = 30, maxBytes = 16384) {
  let fd;
  try {
    fd = openSync(CURRENT_MD, "r");
  } catch {
    return "(current.md not found)";
  }
  try {
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    const lines = buf.toString("utf8").split("\n");
    return lines.slice(-maxLines).join("\n") || "(empty)";
  } finally {
    closeSync(fd);
  }
}

// approve:<card> — kick off the deploy without blocking the poll loop.
function spawnDeploy(card) {
  const child = spawn(process.execPath, [DEPLOY_SCRIPT, card], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

// reject:<card> — drop a marker file. ralph-loop.mjs watches .harness/reject/
// and, when it sees one, re-injects the error context and resumes the iteration.
function writeReject(card) {
  mkdirSync(REJECT_DIR, { recursive: true });
  writeFileSync(
    resolve(REJECT_DIR, `${card}.json`),
    JSON.stringify({ card, at: new Date().toISOString() }, null, 2) + "\n",
  );
}

async function dispatch({ token, chatId }, cb) {
  const data = String(cb.data || "");
  const sep = data.indexOf(":");
  const action = sep === -1 ? data : data.slice(0, sep);
  const card = sep === -1 ? "" : data.slice(sep + 1);

  if (action === "approve") {
    spawnDeploy(card);
    await answerCallback(token, cb.id, "배포를 시작합니다");
    // Ground-truth label: you approved a change the persona had held. This is the
    // most informative sample there is (it sat at p≈0.5) — feed it back so the
    // persona learns the boundary it got wrong.
    try { recordLabel({ card, label: "approve", source: "tap" }); } catch {}
    try { await log("approve", { card, actor: "telegram", detail: { card } }); } catch {}
  } else if (action === "reject") {
    writeReject(card);
    // Ground-truth negative: either a held change you declined, or a rollback of
    // one the persona auto-approved (a costly false-approve to learn from).
    try { recordLabel({ card, label: "reject", source: "tap" }); } catch {}
    
    // Find the commit matching the card
    const logRes = await runCmd("git", ["log", "--grep=loop:" + card, "-n", "1", "--format=%H"], ROOT);
    const commitHash = logRes.stdout.trim();
    
    let revertStatus = "";
    if (commitHash) {
      // Revert the commit and push
      const revertRes = await runCmd("git", ["revert", commitHash, "--no-edit"], ROOT);
      if (revertRes.code === 0) {
        await runCmd("git", ["push"], ROOT);
        spawnDeploy(card);
        revertStatus = " (배포 롤백 완료)";
      } else {
        revertStatus = " (롤백 실패: 충돌 또는 수동 처리 필요)";
      }
    }
    
    // Reset backlog status to open
    try {
      const backlog = await getBacklog();
      backlog.setStatus(card, "open");
    } catch (err) {
      console.error("[Listener] Failed to set status to open:", err.message);
    }

    await answerCallback(token, cb.id, `반려했습니다 — 로직 수정 후 재개합니다${revertStatus}`);
    try { await log("reject", { card, actor: "telegram", detail: { card, rolledBack: !!commitHash } }); } catch {}
  } else if (action === "logs") {
    await sendMessage(token, chatId, "<current.md tail>\n" + tailCurrentMd());
    await answerCallback(token, cb.id, "로그를 전송했습니다");
  } else {
    await answerCallback(token, cb.id, "알 수 없는 동작");
  }
}

async function run() {
  const { token, chatId } = requireEnv();
  console.log("telegram-listener: polling getUpdates (Ctrl+C to stop)");
  let offset = 0;

  for (;;) {
    try {
      const res = await fetch(
        api(token, "getUpdates") +
          `?timeout=${POLL_TIMEOUT}&offset=${offset}&allowed_updates=["callback_query"]`,
      );
      const body = await res.json().catch(() => ({}));
      if (!body.ok) {
        console.error(`getUpdates failed: ${body.description || res.status}`);
        await new Promise((r) => setTimeout(r, BACKOFF_MS));
        continue;
      }
      for (const update of body.result || []) {
        offset = update.update_id + 1; // advance past every processed update
        const cb = update.callback_query;
        if (!cb) continue;
        await dispatch({ token, chatId }, cb);
      }
    } catch (e) {
      console.error(`poll error: ${e.message || e}`);
      await new Promise((r) => setTimeout(r, BACKOFF_MS));
    }
  }
}

// CLI: `node scripts/loop/telegram-listener.mjs` runs the daemon forever.
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
