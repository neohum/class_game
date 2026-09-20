// notify-telegram.mjs — push the autonomous build report to Telegram with buttons.
//
// When the loop finishes an iteration it sends one message to the human's phone:
// the module name, the verification result, and a link to the review screenshot.
// Three inline buttons let the human steer the loop without opening a terminal —
// approve the deploy, reject with "fix the logic", or pull the detailed error log.
// telegram-listener.mjs is the other half: it long-polls for which button was tapped.
//
// No external dependency — we use Node's built-in global fetch (Node >= 18).
//
// Required env (validated; missing ones are listed before we exit):
//   TELEGRAM_BOT_TOKEN  bot token from @BotFather
//   TELEGRAM_CHAT_ID    chat/channel id to deliver to

import { log } from "./telemetry.mjs";

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

// Two message shapes:
//   "deployed" — the persona auto-approved and the change already shipped. This is
//                informational; the only action is a rollback (reject) if it looks
//                wrong after the fact.
//   "approval" — the persona HELD the deploy and is asking the human to decide.
//                Adds an ✅ approve button (telegram-listener spawns the deploy).
function buildMessage({ card, status, tests, screenshotUrl, mode, reason }) {
  if (mode === "approval") {
    return [
      "[승인 필요 — 페르소나가 자동 배포를 보류했습니다]",
      `- 대상 모듈: ${card}`,
      `- 검증 결과: ${tests ?? "n/a"}, 빌드 ${status}`,
      `- 보류 사유: ${reason || "(사유 없음)"}`,
      `- 화면 캡처: ${screenshotUrl ?? "(없음)"}`,
      `- 배포 상태: 커밋/푸시 완료, 배포는 승인 대기 중`,
    ].join("\n");
  }
  return [
    "[에이전트 자율 배포 완료]",
    `- 대상 모듈: ${card}`,
    `- 검증 결과: ${tests ?? "n/a"}, 빌드 ${status}`,
    `- 배포 결정: 페르소나 자동 승인${reason ? ` — ${reason}` : ""}`,
    `- 화면 캡처: ${screenshotUrl ?? "(없음)"}`,
    `- 배포 상태: 자동 배포 완료`,
  ].join("\n");
}

function buildKeyboard(card, mode) {
  if (mode === "approval") {
    return {
      inline_keyboard: [
        [{ text: "✅ 승인 (배포)", callback_data: `approve:${card}` }],
        [
          { text: "↩ 반려 (재개발)", callback_data: `reject:${card}` },
          { text: "🔎 상세 로그", callback_data: `logs:${card}` },
        ],
      ],
    };
  }
  return {
    inline_keyboard: [
      [
        { text: "↩ 반려 (롤백/재개발)", callback_data: `reject:${card}` },
        { text: "🔎 상세 에러 로그", callback_data: `logs:${card}` },
      ],
    ],
  };
}

/**
 * Send the build report to Telegram with the right buttons for the mode.
 * @param {{card:string, status:string, tests?:string, screenshotUrl?:string, mode?:string, reason?:string}} report
 * @returns {Promise<object>} the Telegram API result object
 */
export async function notify({ card, status, tests, screenshotUrl, mode = "deployed", reason = "" }) {
  const { token, chatId } = requireEnv();

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // No parse_mode: the message is plain text. With parse_mode set, a stray
      // `<`, `>`, or `&` in card/tests/url would make Telegram reject the whole
      // message with a parse error.
      chat_id: chatId,
      text: buildMessage({ card, status, tests, screenshotUrl, mode, reason }),
      reply_markup: buildKeyboard(card, mode),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.error(`telegram sendMessage failed: ${data.description || res.status}`);
    process.exit(1);
  }

  try {
    await log("iterate", { card, actor: "telegram", detail: { card, status } });
  } catch { /* telemetry must never break the notify */ }

  return data.result;
}

// CLI: `node scripts/loop/notify-telegram.mjs <card> <status> [testsSummary] [screenshotUrl] [mode] [reason]`
//   mode: "deployed" (default) | "approval"
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [card, status, tests, screenshotUrl, mode, reason] = process.argv.slice(2);
  if (!card || !status) {
    console.error("usage: notify-telegram.mjs <card> <status> [testsSummary] [screenshotUrl] [mode] [reason]");
    process.exit(2);
  }
  notify({ card, status, tests, screenshotUrl, mode, reason })
    .then(() => console.log(`✓ notified: ${card} (${status})`))
    .catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
