#!/usr/bin/env node
// harness-radar.ts — background scout for new harnesses, skills, and techniques.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { laneArgs } from "./lanes.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const STATE = resolve(ROOT, ".harness", "harness-radar.json");
const LOCK = resolve(ROOT, ".harness", "harness-radar.lock");
const SCOUT_TIMEOUT_MS = Math.max(30_000, Number(process.env.HARNESS_RADAR_TIMEOUT_MS || 120_000));
const LOCK_STALE_MS = SCOUT_TIMEOUT_MS + 30_000;

function quote(value: unknown): string {
  return process.platform === "win32" ? `\"${value}\"` : `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function radarPlan({ root = ROOT, node = process.execPath } = {}) {
  const script = join(root, "scripts", "loop", "harness-radar.ts");
  return { scout: `${quote(node)} ${quote(script)} scout`, list: `${quote(node)} ${quote(script)} list` };
}

function readState() {
  try { return JSON.parse(readFileSync(STATE, "utf8")); }
  catch { return { updatedAt: null, status: "idle", findings: [] }; }
}

/** One harness/skill/technique the scout surfaced. */
export interface Finding {
  name: string;
  url: string;
  why: string;
  tags: string[];
}

function jsonArrays(text: unknown): unknown[] {
  const source = String(text);
  const arrays: unknown[] = [];
  for (let start = source.indexOf("["); start >= 0; start = source.indexOf("[", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < source.length; end++) {
      const char = source[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "[") depth += 1;
      else if (char === "]" && --depth === 0) {
        try { arrays.push(JSON.parse(source.slice(start, end + 1))); } catch { /* try the next [ */ }
        break;
      }
    }
  }
  return arrays;
}

const isFinding = (item: unknown): item is Finding =>
  Boolean(item) && typeof (item as Finding).name === "string" && typeof (item as Finding).url === "string";

export function parseFindings(text: unknown): Finding[] {
  const parsed = jsonArrays(text).find((value): value is unknown[] =>
    Array.isArray(value) && value.some(isFinding));
  if (!parsed) return [];
  return parsed.filter(isFinding)
    .slice(0, 8).map((item) => ({
      name: item.name.slice(0, 120), url: item.url.slice(0, 500),
      why: String(item.why || "").slice(0, 800), tags: Array.isArray(item.tags) ? item.tags.slice(0, 6) : [],
    }));
}

function acquireLock() {
  const marker = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  try {
    writeFileSync(LOCK, marker, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") return false;
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) {
        rmSync(LOCK, { force: true });
        writeFileSync(LOCK, marker, { flag: "wx" });
        return true;
      }
    } catch { /* another scout won the race */ }
    return false;
  }
}

async function scout() {
  mkdirSync(dirname(STATE), { recursive: true });
  if (!acquireLock()) return;
  const prompt = [
    "Act as a background technology scout for create-agent-harness.",
    "Use web research when available. Find up to 8 recent, credible open-source agent harnesses, skills, orchestration, memory, testing, or deployment techniques.",
    "Do not install packages or edit files. Return only a JSON array: [{name,url,why,tags}]. Explain concrete adoption value and avoid duplicates.",
  ].join("\n");
  try {
    const result = await new Promise<{ code: number; text: string; timedOut: boolean }>((done) => {
      const child = spawn(process.execPath, [resolve(HERE, "..", "agent-session.ts"), ...laneArgs("radar"), prompt], {
        cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      let text = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, SCOUT_TIMEOUT_MS);
      child.stdout.on("data", (chunk) => { text += chunk; });
      child.stderr.on("data", (chunk) => { text += chunk; });
      child.on("exit", (code) => { clearTimeout(timer); done({ code: code ?? 1, text, timedOut }); });
      child.on("error", (error) => { clearTimeout(timer); done({ code: 1, text: `${text}\n${error.message}`, timedOut }); });
    });
    const prior = readState().findings || [];
    const discovered = parseFindings(result.text);
    const byUrl = new Map([...discovered, ...prior].map((item) => [item.url, item]));
    const error = discovered.length ? null : String(result.text || `agent exited ${result.code}`).trim().slice(-1_000);
    writeFileSync(STATE, JSON.stringify({
      updatedAt: new Date().toISOString(),
      status: discovered.length ? "ready" : result.timedOut ? "timed_out" : "unavailable",
      lastError: result.timedOut ? `scout exceeded ${SCOUT_TIMEOUT_MS}ms: ${error || "no output"}` : error || null,
      findings: [...byUrl.values()].slice(0, 30),
    }, null, 2) + "\n");
  } finally { rmSync(LOCK, { force: true }); }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const command = process.argv[2] || "list";
  if (command === "scout") await scout();
  else if (command === "list") console.log(JSON.stringify(readState(), null, 2));
  else { console.error("usage: harness-radar.ts <scout|list>"); process.exitCode = 2; }
}
