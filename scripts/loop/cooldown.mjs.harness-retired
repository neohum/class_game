// cooldown.mjs — per-agent rate-limit cooldown tracking.
//
// When an agent CLI (claude / codex / antigravity / gemini) hits a subscription
// or rate limit, we record WHEN it is allowed to run again. The loop reads this
// to pick a builder/reviewer that is NOT in cooldown, and to bring an agent back
// to its primary role the moment its reset time passes.
//
// State lives in .harness/cooldown.json under the project root:
//   { "claude": { "until": 1717400000000, "reason": "5h limit", "at": 1717382000000 },
//     "codex":  { ... } }
//
// `until` is an epoch-ms timestamp. An agent is "available" when no entry exists
// or Date.now() >= until. Everything here is plain Node + JSON so it runs the
// same on the server and on Windows.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const ROOT = resolve(process.cwd());
const FILE = resolve(ROOT, ".harness", "cooldown.json");

function read() {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) || {};
  } catch {
    return {}; // corrupt file must never wedge the loop
  }
}

function write(state) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(state, null, 2));
}

// Record that `agent` is limited until `untilMs` (epoch ms). `now` is injectable
// for testability (Date.now() is unavailable in some sandboxes).
export function setCooldown(agent, untilMs, { reason = "", now = Date.now() } = {}) {
  const state = read();
  state[agent] = { until: untilMs, reason, at: now };
  write(state);
  return state[agent];
}

// True if the agent is currently in cooldown (limited and not yet reset).
export function inCooldown(agent, now = Date.now()) {
  const e = read()[agent];
  return Boolean(e && typeof e.until === "number" && now < e.until);
}

// ms remaining until the agent resets (0 if available).
export function remaining(agent, now = Date.now()) {
  const e = read()[agent];
  if (!e || typeof e.until !== "number") return 0;
  return Math.max(0, e.until - now);
}

// Clear an agent's cooldown (e.g. after a successful run, or when it resets).
export function clearCooldown(agent) {
  const state = read();
  if (state[agent]) {
    delete state[agent];
    write(state);
  }
}

// Return the full map of agents -> entry, dropping any whose reset has passed.
// Side effect: prunes expired entries so the file stays tidy.
export function activeCooldowns(now = Date.now()) {
  const state = read();
  let changed = false;
  for (const [agent, e] of Object.entries(state)) {
    if (!e || typeof e.until !== "number" || now >= e.until) {
      delete state[agent];
      changed = true;
    }
  }
  if (changed) write(state);
  return state;
}

// Fixed-duration fallback windows (ms) when we can't parse a reset time from
// the CLI output. Tuned to the documented limit windows per provider.
export const DEFAULT_WINDOWS = {
  claude: 5 * 60 * 60 * 1000,        // Claude subscription: ~5h rolling window
  codex: 5 * 60 * 60 * 1000,         // Codex: ~5h
  gemini: 24 * 60 * 60 * 1000,       // Gemini free tier: daily
  antigravity: 24 * 60 * 60 * 1000,  // Antigravity: daily
};

// Parse a reset time out of a CLI's stdout/stderr. Returns epoch-ms or null.
//
// Tuned to the ACTUAL Claude Code CLI limit messages (verified against
// anthropics/claude-code issues + support.claude.com), most-precise first:
//
//   1. headless epoch  "Claude AI usage limit reached|1749924000"   (exact, UTC)
//   2. ISO timestamp   "...2026-06-03T15:00:00Z..."                 (exact)
//   3. retry-after     "retry-after: 3600"  / 429 Retry-After       (exact, rel)
//   4. clock + tz      "reset at 3pm (America/New_York)"            (tz-correct)
//   5. weekly date     "resets Oct 6, 1pm"  /  "resets Oct 24"      (date form)
//   6. clock, no tz    "reset at 3pm" / "resets 5am" / "at 15:00"   (local time)
//   7. relative dur    "try again in 2h 30m"                        (generic)
//
// `now` is injectable for testing. Anything unparseable returns null and the
// caller falls back to the documented per-provider window.
export function parseResetTime(text, now = Date.now()) {
  if (!text) return null;
  const s = String(text);

  // 1. Headless form: "Claude AI usage limit reached|<unix-seconds>". This is
  //    the exact reset moment in UTC seconds — the single most reliable signal.
  const epoch = s.match(/usage limit reached\s*\|\s*(\d{10})\b/i);
  if (epoch) {
    const t = Number(epoch[1]) * 1000;
    if (t > now) return t;
  }

  // 2. ISO-8601 timestamp (rare in CLI text, but unambiguous when present).
  const iso = s.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (iso) {
    const t = Date.parse(iso[1]);
    if (!Number.isNaN(t) && t > now) return t;
  }

  // 3. retry-after header (seconds), as surfaced in wrapped 429 errors.
  const retry = s.match(/retry-?after["':\s]+(\d{1,7})\b/i);
  if (retry) {
    const t = now + Number(retry[1]) * 1000;
    if (t > now) return t;
  }

  // 4. Clock time WITH an IANA timezone: "reset at 3pm (America/New_York)".
  //    Resolve the wall-clock time IN THAT ZONE so a server in another tz still
  //    computes the right instant. "resets" (no "at") is also accepted.
  const tzClock = s.match(/(?:reset(?:s)?(?:\s+at)?|resets)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([A-Za-z]+\/[A-Za-z0-9_+-]+|UTC)\)/i);
  if (tzClock) {
    const t = clockInZoneToEpoch(tzClock, now);
    if (t && t > now) return t;
  }

  // 5. Weekly form: "resets Oct 6, 1pm" or "resets Oct 24" (abbrev month + day).
  const weekly = s.match(/resets?\s+([A-Z][a-z]{2})\s+(\d{1,2})(?:,?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/);
  if (weekly) {
    const t = monthDayToEpoch(weekly, now);
    if (t && t > now) return t;
  }

  // 6. Clock time, no timezone — interpret in the loop host's local tz.
  //    Matches "reset at 3pm", "resets 5am", "at 15:00", "at 3:30 PM".
  const clock = s.match(/(?:reset(?:s)?(?:\s+at)?|resets|at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (clock) {
    const t = clockToEpoch(clock, now);
    if (t && t > now) return t;
  }

  // 7. Relative duration: "in 2h", "in 90 minutes", "in 2h 30m", "in 1 hour".
  const rel = s.match(/in\s+((?:\d+\s*(?:h|hr|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\s*)+)/i);
  if (rel) {
    const ms = durationToMs(rel[1]);
    if (ms > 0) return now + ms;
  }

  return null;
}

function durationToMs(str) {
  let ms = 0;
  const re = /(\d+)\s*(h|hr|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)/gi;
  let m;
  while ((m = re.exec(str))) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit.startsWith("h")) ms += n * 3600_000;
    else if (unit.startsWith("m")) ms += n * 60_000;
    else ms += n * 1000;
  }
  return ms;
}

// Normalize an [_, hh, mm?, am|pm?] match to 24h { hh, mm } or null if invalid.
function to24h(match) {
  let hh = Number(match[1]);
  const mm = match[2] ? Number(match[2]) : 0;
  const ap = match[3] ? match[3].toLowerCase() : null;
  if (ap === "pm" && hh < 12) hh += 12;
  if (ap === "am" && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

// Convert a matched clock-time to the next future epoch-ms. Uses local time
// (the loop host's timezone) — correct when the message carries no tz.
function clockToEpoch(match, now) {
  const hm = to24h(match);
  if (!hm) return null;
  const d = new Date(now);
  d.setHours(hm.hh, hm.mm, 0, 0);
  let t = d.getTime();
  if (t <= now) t += 24 * 3600_000; // already passed today -> tomorrow
  return t;
}

// Convert "3pm (America/New_York)" to the next future epoch-ms, honoring the
// named IANA zone. We find the instant whose wall-clock time in that zone is
// hh:mm by checking the zone's offset and correcting. Works without any tz
// library by asking Intl what time a candidate instant shows in that zone.
function clockInZoneToEpoch(match, now) {
  const hm = to24h(match); // groups: [_, hh, mm, ap, tz]
  if (!hm) return null;
  const tz = match[4];

  // Start from "today in that zone" and build a candidate for hh:mm there.
  // Strategy: compute the zone's current offset (ms) from UTC, then pick the
  // UTC instant that maps to today's hh:mm in the zone; roll forward a day if
  // it's already past.
  for (let dayAhead = 0; dayAhead <= 1; dayAhead++) {
    const base = new Date(now + dayAhead * 24 * 3600_000);
    const parts = zoneParts(base, tz);
    if (!parts) return clockToEpoch(match, now); // unknown tz -> local fallback
    // Build the UTC ms for the zone-local Y/M/D at hh:mm, using the offset that
    // applies on that date.
    const offsetMs = zoneOffsetMs(base, tz);
    const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, hm.hh, hm.mm, 0) - offsetMs;
    // Re-derive the offset at the guessed instant (handles DST edges) and
    // correct once — good enough for a cooldown estimate.
    const corrected = Date.UTC(parts.year, parts.month - 1, parts.day, hm.hh, hm.mm, 0) - zoneOffsetMs(new Date(utcGuess), tz);
    if (corrected > now) return corrected;
  }
  return null;
}

// Y/M/D shown in a given IANA zone for an instant. null if the zone is invalid.
function zoneParts(date, tz) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    });
    const o = {};
    for (const p of fmt.formatToParts(date)) if (p.type !== "literal") o[p.type] = Number(p.value);
    return { year: o.year, month: o.month, day: o.day };
  } catch {
    return null;
  }
}

// Offset (ms) of an IANA zone from UTC at a given instant: zone-local - UTC.
// e.g. America/New_York in winter -> -5h -> -18000000.
function zoneOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const o = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== "literal") o[p.type] = Number(p.value);
  const asUTC = Date.UTC(o.year, o.month - 1, o.day, o.hour === 24 ? 0 : o.hour, o.minute, o.second);
  return asUTC - date.getTime();
}

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

// Convert a weekly "Oct 6, 1pm" / "Oct 24" match to epoch-ms (local time).
// match groups: [_, mon, day, hh?, mm?, ap?]. Year is inferred: the next
// occurrence of that month/day at-or-after now (handles year rollover).
function monthDayToEpoch(match, now) {
  const mon = MONTHS[match[1].toLowerCase()];
  if (mon === undefined) return null;
  const day = Number(match[2]);
  if (day < 1 || day > 31) return null;
  const hm = match[3] ? to24h([null, match[3], match[4], match[5]]) : { hh: 0, mm: 0 };
  if (!hm) return null;
  const ref = new Date(now);
  for (let yearAhead = 0; yearAhead <= 1; yearAhead++) {
    const d = new Date(ref.getFullYear() + yearAhead, mon, day, hm.hh, hm.mm, 0, 0);
    const t = d.getTime();
    if (t > now) return t;
  }
  return null;
}
