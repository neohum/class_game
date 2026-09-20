// telegram-listener.ts — long-poll daemon that reacts to inline-button taps.
//
// notify-telegram.ts sends a build report with three buttons; this daemon is
// the other half. It long-polls getUpdates and dispatches each callback_query:
//
//   approve:<card>  release the held deploy (decide.ts approveCard)
//   reject:<card>   revert + reopen the card (decide.ts rejectCard) — ralph-loop
//                   re-injects the rejection context on the next prime
//   logs:<card>     reply with the tail of current.md (the live action trail)
//
// The decision actions live in decide.ts and are shared with the session-prompt
// channel (`decide.ts approve|reject <card>` / the decision_* MCP tools) — the
// phone tap and the chat message do exactly the same thing.
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

import { resolve } from "node:path";
import { openSync, fstatSync, readSync, closeSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { approveCard, rejectCard } from "./decide.ts";

const ROOT = resolve(process.cwd());
const CURRENT_MD = resolve(ROOT, "current.md");
const POLL_TIMEOUT = 50; // seconds — Telegram long-poll window
const BACKOFF_MS = 3000; // wait this long after a failed poll iteration

function requireEnv(): { token: string; chatId: string } {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const missing = [];
  if (!token) missing.push("TELEGRAM_BOT_TOKEN");
  if (!chatId) missing.push("TELEGRAM_CHAT_ID");
  if (missing.length) {
    console.error(`missing required env: ${missing.join(", ")}`);
    process.exit(2);
  }
  // process.exit above makes this unreachable when either is unset, but the
  // compiler cannot see that through the console.error branch.
  return { token: token!, chatId: chatId! };
}

const api = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

/** A decision handler, as decide exports them. */
export type DecisionHandler = typeof approveCard;

/** The Telegram callback_query fields this listener actually reads. */
export interface CallbackQuery {
  id: string;
  data?: string;
  message?: { chat?: { id?: number | string } };
}

async function answerCallback(token: string, callbackQueryId: string, text: string) {
  try {
    await fetch(api(token, "answerCallbackQuery"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch { /* spinner cleanup is best-effort */ }
}

async function sendMessage(token: string, chatId: string | number, text: string) {
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

// approve/reject are shared with the session-prompt channel (decide.ts): the
// same functions release the deploy, record the ground-truth persona label,
// revert/reopen on rejection, and clear the pending marker. `force` because a
// Telegram tap is always an explicit human decision, even if the session
// channel already consumed the marker for a different card state.
export async function dispatch(
  { token, chatId }: { token: string; chatId: string | number },
  cb: CallbackQuery,
  { approve = approveCard, reject = rejectCard }: {
    approve?: DecisionHandler;
    reject?: DecisionHandler;
  } = {},
) {
  const cbChatId = cb.message?.chat?.id;
  if (cbChatId === undefined || String(cbChatId) !== String(chatId)) {
    await answerCallback(token, cb.id, "권한이 없습니다");
    return;
  }

  const data = String(cb.data || "");
  const parts = data.split(":");
  const action = parts[0] || "";
  const card = parts[1] || "";
  const nonce = parts[2] || "";

  if (action === "approve") {
    const r = await approve(card, { actor: "telegram", nonce });
    if (r?.error) {
      await answerCallback(token, cb.id, `승인 실패: ${r.error}`);
    } else {
      await answerCallback(token, cb.id, "배포를 시작합니다");
    }
  } else if (action === "reject") {
    const r = await reject(card, { actor: "telegram", nonce });
    if (r?.error) {
      await answerCallback(token, cb.id, `반려 실패: ${r.error}`);
    } else {
      const revertStatus = r?.rolledBack ? " (배포 롤백 완료)" : "";
      await answerCallback(token, cb.id, `반려했습니다 — 로직 수정 후 재개합니다${revertStatus}`);
    }
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
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
        result?: Array<{ update_id: number; callback_query?: CallbackQuery }>;
      };
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
      console.error(`poll error: ${(e as Error)?.message || e}`);
      await new Promise((r) => setTimeout(r, BACKOFF_MS));
    }
  }
}

// CLI: `node scripts/loop/telegram-listener.ts` runs the daemon forever.
// `import.meta.url` is realpath-resolved by the loader, while `process.argv[1]` is
// the raw path the caller typed. On a symlinked path (macOS /tmp -> /private/tmp,
// /var -> /private/var, linked checkouts) the two differ and a naive comparison
// makes this CLI silently no-op with exit 0. Compare both through realpath.
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  run().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
