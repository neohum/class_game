// deliverable-preview.ts — production build + observed runtime completion gate.

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { changedPaths, isVisualSurface } from "./brand-assets.ts";

export interface PreviewManifest {
  schema: 1;
  card: string;
  productionBuild: {
    command: string;
    exitCode: number;
    artifact: string;
    log: string;
  };
  runtime: {
    kind: "web" | "desktop";
    status: "observed" | "waiting-for-visual-review";
    url?: string;
    windowId?: string;
    readyMethod?: string;
    readyStatus?: number | string;
    process?: { pid: number; cleanedUp: boolean };
    screenshot?: string;
    manualCommand?: string;
  };
  contract: string;
}

export interface PreviewVerdict {
  applicable: boolean;
  ok: boolean;
  status: "not-applicable" | "observed" | "waiting-for-visual-review" | "blocked";
  manifests: string[];
  errors: string[];
}

function safeFile(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!path || rel === ".." || rel.startsWith(".." + sep)) throw new Error("path escapes project root: " + path);
  if (!existsSync(absolute)) throw new Error("file is missing: " + path);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || statSync(absolute).size === 0) {
    throw new Error("file must be a non-empty regular file: " + path);
  }
  const realRel = relative(realpathSync(root), realpathSync(absolute));
  if (realRel === ".." || realRel.startsWith(".." + sep)) throw new Error("file resolves outside project root: " + path);
  return absolute;
}

function evidenceFile(root: string, path: string, label: string, minimum = 1): string {
  const file = safeFile(root, path);
  if (!path.replace(/\\/g, "/").startsWith("evidence/") || statSync(file).size < minimum) {
    throw new Error(label + " must be a non-empty file under evidence/");
  }
  return file;
}

function loopbackURL(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && Boolean(url.port)
      && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function validate(root: string, path: string): { errors: string[]; waiting: boolean } {
  const errors: string[] = [];
  let manifest: PreviewManifest;
  try {
    manifest = JSON.parse(readFileSync(safeFile(root, path), "utf8")) as PreviewManifest;
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)], waiting: false };
  }
  if (manifest.schema !== 1) errors.push("schema must be 1");
  if (!manifest.card?.trim()) errors.push("card is required");
  const build = manifest.productionBuild;
  if (!build?.command?.trim()) errors.push("production build command is required");
  if (/\b(deploy|publish|upload|push)\b/i.test(build?.command || "")) {
    errors.push("production build evidence cannot contain deploy/publish/upload/push");
  }
  if (build?.exitCode !== 0) errors.push("production build exitCode must be 0");
  try { safeFile(root, build.artifact); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  try {
    const logPath = evidenceFile(root, build.log, "build log", 20);
    const log = readFileSync(logPath, "utf8");
    if (!log.includes(build.command) || !/(exitCode|exit code)\s*[=:]\s*0/i.test(log)) {
      errors.push("build log must contain the exact command and exitCode=0");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const runtime = manifest.runtime;
  if (!runtime || !["web", "desktop"].includes(runtime.kind)) errors.push("runtime kind must be web or desktop");
  if (runtime?.status === "waiting-for-visual-review") {
    if (!runtime.manualCommand?.trim()) errors.push("waiting runtime requires a concrete manualCommand");
    errors.push("waiting-for-visual-review: " + (runtime.manualCommand || "manual command missing"));
    return { errors, waiting: true };
  }
  if (runtime?.status !== "observed") errors.push("runtime status must be observed or waiting-for-visual-review");
  if (!runtime?.readyMethod?.trim() || runtime.readyStatus === undefined || runtime.readyStatus === null) {
    errors.push("runtime readiness method and observed status are required");
  }
  if (runtime?.kind === "web" && !loopbackURL(runtime.url || "")) {
    errors.push("web preview URL must be loopback http with an explicit port");
  }
  if (runtime?.kind === "desktop" && !runtime.windowId?.trim()) {
    errors.push("desktop preview requires an observed windowId");
  }
  if (!runtime?.process || runtime.process.pid <= 0 || runtime.process.cleanedUp !== true) {
    errors.push("preview process must have a pid and be cleaned up after observation");
  }
  try {
    const screenshot = evidenceFile(root, runtime.screenshot || "", "runtime screenshot", 512);
    if (!/\.(png|jpe?g|webp)$/i.test(extname(screenshot))) errors.push("runtime screenshot must be an image");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    const contract = readFileSync(safeFile(root, manifest.contract), "utf8");
    if (!/(production|프로덕션).*(build|빌드)/is.test(contract)
      || !/(실행|preview|launch|runtime)/i.test(contract)
      || !/(screenshot|스크린샷|화면\s*캡처)/i.test(contract)) {
      errors.push("plan/review contract must require production build, runtime launch and screenshot");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { errors, waiting: false };
}

export function verifyDeliverablePreview(options: {
  root?: string;
  paths?: string[];
  manifests?: string[];
} = {}): PreviewVerdict {
  const root = resolve(options.root || process.cwd());
  const paths = options.paths || changedPaths(root);
  if (!paths.some(isVisualSurface)) {
    return { applicable: false, ok: true, status: "not-applicable", manifests: [], errors: [] };
  }
  const manifests = options.manifests || paths.filter((path) => /^evidence\/[^/]+\/deliverable-preview\.json$/i.test(path));
  if (manifests.length === 0) {
    return {
      applicable: true, ok: false, status: "blocked", manifests,
      errors: ["app/web changes require a changed evidence/<card>/deliverable-preview.json"],
    };
  }
  let waiting = false;
  const errors = manifests.flatMap((path) => {
    const result = validate(root, path);
    waiting ||= result.waiting;
    return result.errors.map((error) => path + ": " + error);
  });
  return {
    applicable: true,
    ok: errors.length === 0,
    status: waiting ? "waiting-for-visual-review" : errors.length ? "blocked" : "observed",
    manifests,
    errors,
  };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
})();

if (isMain) {
  const verdict = verifyDeliverablePreview();
  if (!verdict.applicable) console.log("deliverable preview: no app/web surface changed");
  else if (verdict.ok) console.log("deliverable preview: observed " + verdict.manifests.map((path) => basename(path)).join(", "));
  else {
    console.error("deliverable preview: " + verdict.status + "\n" + verdict.errors.map((error) => "- " + error).join("\n"));
    process.exit(1);
  }
}
