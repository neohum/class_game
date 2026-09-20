// brand-assets.ts — fail-closed brand completion gate for app/web changes.

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface BrandAssetRef {
  path: string;
  references: string[];
  sizes?: number[];
  minSize?: number;
}

export interface BrandManifest {
  schema: 1;
  card: string;
  mode: "created" | "reused";
  source: string;
  logo: BrandAssetRef;
  favicon: BrandAssetRef;
  appIcon: BrandAssetRef;
  screenshot: string;
  contract: string;
}

export interface BrandVerdict {
  applicable: boolean;
  ok: boolean;
  manifests: string[];
  errors: string[];
}

function gitLines(root: string, args: string[]): string[] {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return [];
  return String(result.stdout).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

export function changedPaths(root = process.cwd()): string[] {
  return [...new Set([
    ...gitLines(root, ["diff", "--name-only", "HEAD"]),
    ...gitLines(root, ["ls-files", "--others", "--exclude-standard"]),
  ].map((path) => path.replace(/\\/g, "/")))];
}

/**
 * 패키지 매니페스트와 lockfile은 UI 디렉터리 안에 있어도 화면이 아니다.
 *
 * 이 예외가 없으면 `version-sync bump`가 `<app>/package.json`을 건드리는 것만으로
 * 브랜드 게이트가 열려, 로고 한 픽셀 바뀌지 않은 버전 올림에도 로고·앱 아이콘·
 * 파비콘·스크린샷 증거를 요구한다. 모든 릴리스에서 반드시 걸리는 게이트는 지켜지는
 * 게이트가 아니라 우회되는 게이트가 된다. 실제 UI 소스(.tsx/.css/…)는 그대로 연다.
 */
const MANIFEST_FILES = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig(\.[^/]+)?\.json|jsconfig\.json|go\.(mod|sum))$/;

export function isVisualSurface(path: string): boolean {
  const value = path.replace(/\\/g, "/").toLowerCase();
  if (value.startsWith("evidence/") || value.startsWith("plans/")) return false;
  if (MANIFEST_FILES.test(value)) return false;
  if (/\.(html?|css|scss|sass|less|tsx|jsx|vue|svelte|dart|swift|xaml)$/.test(value)) return true;
  return /(^|\/)(app|apps|web|website|frontend|ui|mobile|desktop)(\/|$)/.test(value)
    && /\.(ts|js|json|xml|yaml|yml|go|kt|kts)$/.test(value);
}

function safeFile(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!path || rel === ".." || rel.startsWith(".." + sep)) {
    throw new Error("path escapes project root: " + path);
  }
  if (!existsSync(absolute)) throw new Error("file is missing: " + path);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || statSync(absolute).size === 0) {
    throw new Error("file must be a non-empty regular file: " + path);
  }
  const realRel = relative(realpathSync(root), realpathSync(absolute));
  if (realRel === ".." || realRel.startsWith(".." + sep)) {
    throw new Error("file resolves outside project root: " + path);
  }
  return absolute;
}

function svgSize(content: string): { width: number; height: number } | null {
  if (!/<svg\b/i.test(content)) return null;
  const viewBox = content.match(/viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
  if (!viewBox) return null;
  return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
}

function rasterSize(data: Buffer, extension: string): { width: number; height: number } | null {
  if (extension === ".png" && data.length >= 24 && data.subarray(1, 4).toString() === "PNG") {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  return null;
}

function validateReferences(root: string, asset: BrandAssetRef, errors: string[], label: string): void {
  if (!Array.isArray(asset.references) || asset.references.length === 0) {
    errors.push(label + " has no usage reference");
    return;
  }
  const needle = basename(asset.path);
  for (const reference of asset.references) {
    try {
      const file = safeFile(root, reference);
      if (!readFileSync(file, "utf8").includes(needle)) {
        errors.push(label + " is not referenced by " + reference);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
}

function validateAsset(root: string, asset: BrandAssetRef, errors: string[], label: string): void {
  try {
    const file = safeFile(root, asset.path);
    const extension = extname(asset.path).toLowerCase();
    const data = readFileSync(file);
    const size = extension === ".svg" ? svgSize(data.toString("utf8")) : rasterSize(data, extension);
    if (!size) errors.push(label + " must be a valid SVG with viewBox or PNG: " + asset.path);
    if (asset.minSize && (!size || Math.min(size.width, size.height) < asset.minSize)) {
      errors.push(label + " must be at least " + asset.minSize + "px");
    }
    validateReferences(root, asset, errors, label);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

function validateManifest(root: string, path: string): string[] {
  const errors: string[] = [];
  let manifest: BrandManifest;
  try {
    manifest = JSON.parse(readFileSync(safeFile(root, path), "utf8")) as BrandManifest;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (manifest.schema !== 1) errors.push(path + ": schema must be 1");
  if (!manifest.card?.trim()) errors.push(path + ": card is required");
  if (manifest.mode !== "created" && manifest.mode !== "reused") errors.push(path + ": mode must be created or reused");
  try {
    const source = readFileSync(safeFile(root, manifest.source), "utf8");
    if (extname(manifest.source).toLowerCase() !== ".svg" || !svgSize(source)) {
      errors.push(path + ": source must be one valid vector SVG");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (!manifest.logo || !manifest.favicon || !manifest.appIcon) {
    errors.push(path + ": logo, favicon and appIcon are all required");
    return errors;
  }
  validateAsset(root, manifest.logo, errors, "logo");
  validateAsset(root, manifest.favicon, errors, "favicon");
  validateAsset(root, manifest.appIcon, errors, "appIcon");
  const faviconSizes = new Set(manifest.favicon.sizes || []);
  if (!faviconSizes.has(16) || !faviconSizes.has(32)) errors.push("favicon must declare 16px and 32px verification");
  if ((manifest.appIcon.minSize || 0) < 128) errors.push("appIcon minSize must be at least 128px");
  try {
    const screenshot = safeFile(root, manifest.screenshot);
    if (!manifest.screenshot.replace(/\\/g, "/").startsWith("evidence/")
      || !/\.(png|jpe?g|webp)$/i.test(screenshot) || statSync(screenshot).size < 512) {
      errors.push("screenshot must be a non-empty image under evidence/");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    const contract = readFileSync(safeFile(root, manifest.contract), "utf8");
    const terms = [/(logo|로고)/i, /(app[- ]?icon|앱\s*아이콘)/i, /(favicon|파비콘)/i, /(screenshot|스크린샷|화면\s*캡처)/i];
    if (!terms.every((pattern) => pattern.test(contract))) {
      errors.push("plan/review contract must mention logo, app icon, favicon and screenshot evidence");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

export function verifyBrandAssets(options: {
  root?: string;
  paths?: string[];
  manifests?: string[];
} = {}): BrandVerdict {
  const root = resolve(options.root || process.cwd());
  const paths = options.paths || changedPaths(root);
  if (!paths.some(isVisualSurface)) return { applicable: false, ok: true, manifests: [], errors: [] };
  const manifests = options.manifests || paths.filter((path) => /^evidence\/[^/]+\/brand-assets\.json$/i.test(path));
  if (manifests.length === 0) {
    return { applicable: true, ok: false, manifests, errors: ["app/web changes require a changed evidence/<card>/brand-assets.json"] };
  }
  const errors = manifests.flatMap((path) => validateManifest(root, path).map((error) => path + ": " + error));
  return { applicable: true, ok: errors.length === 0, manifests, errors };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
})();

if (isMain) {
  const verdict = verifyBrandAssets();
  if (!verdict.applicable) console.log("brand assets: no app/web surface changed");
  else if (verdict.ok) console.log("brand assets: verified " + verdict.manifests.join(", "));
  else {
    console.error("brand assets: blocked\n" + verdict.errors.map((error) => "- " + error).join("\n"));
    process.exit(1);
  }
}
