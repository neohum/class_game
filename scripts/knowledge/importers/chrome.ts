/**
 * chrome.ts — Direct Chrome & Chromium Bookmarks Importer
 *
 * Automatically locates local Chrome / Brave / Edge / Arc bookmarks files on
 * macOS, Windows, and Linux. Traverses JSON bookmark trees, supports filtering
 * by folder name and recency (added in last N days), and extracts metadata.
 *
 * Invariants:
 * - Read-only: never modifies the browser's Bookmarks file.
 * - Filters out internal schemes (chrome://, javascript:, file:, about:).
 * - Accurately converts WebKit microsecond timestamps into Date objects.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ExtractedChromeBookmark {
  url: string;
  title: string;
  folderPath: string[];
  dateAdded?: Date;
  tags: string[];
}

export interface ChromeBookmarkFolder {
  name: string;
  path: string;
  count: number;
}

export interface ChromeNode {
  id?: string;
  name: string;
  type?: "url" | "folder";
  url?: string;
  date_added?: string;
  date_modified?: string;
  children?: ChromeNode[];
}

export interface ChromeBookmarksFile {
  checksum?: string;
  roots: {
    bookmark_bar?: ChromeNode;
    other?: ChromeNode;
    synced?: ChromeNode;
    [key: string]: ChromeNode | undefined;
  };
  version?: number;
}

/**
 * Converts Chrome/WebKit microsecond timestamp (since 1601-01-01 UTC) into Date.
 */
export function parseChromeTime(dateAddedStr: string | number | undefined): Date | null {
  if (!dateAddedStr || dateAddedStr === "0") return null;
  try {
    const raw = BigInt(dateAddedStr);
    // Microseconds between 1601-01-01 and 1970-01-01 is 11644473600000 ms
    const ms = Number(raw / 1000n) - 11644473600000;
    if (isNaN(ms) || ms <= 0) return null;
    return new Date(ms);
  } catch {
    return null;
  }
}

/**
 * Automatically discovers Chrome & Chromium bookmarks file paths on the local machine.
 */
export function getChromeBookmarksPaths(): string[] {
  const paths: string[] = [];
  const home = homedir();
  const profiles = ["Default", "Profile 1", "Profile 2", "Profile 3", "Profile 4"];

  const checkDirs: string[] = [];

  if (process.platform === "darwin") {
    // macOS paths
    checkDirs.push(join(home, "Library", "Application Support", "Google", "Chrome"));
    checkDirs.push(join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"));
    checkDirs.push(join(home, "Library", "Application Support", "Microsoft Edge"));
    checkDirs.push(join(home, "Library", "Application Support", "Arc", "User Data"));
  } else if (process.platform === "win32") {
    // Windows paths
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    checkDirs.push(join(localAppData, "Google", "Chrome", "User Data"));
    checkDirs.push(join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"));
    checkDirs.push(join(localAppData, "Microsoft", "Edge", "User Data"));
  } else {
    // Linux paths
    const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
    checkDirs.push(join(configHome, "google-chrome"));
    checkDirs.push(join(configHome, "chromium"));
    checkDirs.push(join(configHome, "BraveSoftware", "Brave-Browser"));
    checkDirs.push(join(configHome, "microsoft-edge"));
  }

  for (const base of checkDirs) {
    if (!existsSync(base)) continue;
    for (const prof of profiles) {
      const p = join(base, prof, "Bookmarks");
      if (existsSync(p) && !paths.includes(p)) {
        paths.push(p);
      }
    }
  }

  return paths;
}

/**
 * Resolves the active Chrome Bookmarks file path.
 */
export function resolveChromeBookmarksPath(explicitPath?: string): string {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`지정된 북마크 파일을 찾을 수 없습니다: ${explicitPath}`);
    }
    return explicitPath;
  }

  const found = getChromeBookmarksPaths();
  if (found.length === 0) {
    throw new Error(
      "컴퓨터에서 Chrome 북마크 파일을 찾을 수 없습니다. 경로를 직접 지정해주세요 (--bookmarks <path>)."
    );
  }
  return found[0]!;
}

/**
 * Lists all folders and their bookmark counts in the Chrome Bookmarks file.
 */
export function listChromeBookmarkFolders(bookmarksPath?: string): ChromeBookmarkFolder[] {
  const filePath = resolveChromeBookmarksPath(bookmarksPath);
  const raw = readFileSync(filePath, "utf8");
  const data = JSON.parse(raw) as ChromeBookmarksFile;
  const folders: ChromeBookmarkFolder[] = [];

  function traverse(node: ChromeNode, pathArr: string[]) {
    const isFolder = node.type === "folder" || (!node.type && Array.isArray(node.children));
    if (isFolder && node.children) {
      const currentPath = [...pathArr, node.name];
      const validLinksCount = node.children.filter(
        (c) => c.url && (c.url.startsWith("http://") || c.url.startsWith("https://"))
      ).length;

      if (validLinksCount > 0 || node.children.some((c) => c.children)) {
        folders.push({
          name: node.name,
          path: currentPath.join(" / "),
          count: validLinksCount,
        });
      }

      for (const child of node.children) {
        traverse(child, currentPath);
      }
    }
  }

  for (const rootKey of Object.keys(data.roots || {})) {
    const rootNode = data.roots[rootKey];
    if (rootNode) traverse(rootNode, []);
  }

  return folders;
}

/**
 * Extracts bookmarks from Chrome Bookmarks JSON.
 * Supports filtering by folderName and recency (days).
 */
export function extractChromeBookmarks(options: {
  bookmarksPath?: string;
  folderName?: string;
  days?: number;
} = {}): ExtractedChromeBookmark[] {
  const filePath = resolveChromeBookmarksPath(options.bookmarksPath);
  const raw = readFileSync(filePath, "utf8");
  const data = JSON.parse(raw) as ChromeBookmarksFile;
  const results: ExtractedChromeBookmark[] = [];

  const targetFolder = options.folderName ? options.folderName.trim().toLowerCase() : undefined;
  const minDate = options.days !== undefined && options.days > 0
    ? new Date(Date.now() - options.days * 86400000)
    : undefined;

  function traverse(node: ChromeNode, pathArr: string[], inTargetFolder: boolean) {
    const isFolder = node.type === "folder" || (!node.type && Array.isArray(node.children));

    if (isFolder && node.children) {
      const currentPath = [...pathArr, node.name];
      const folderMatches = targetFolder
        ? node.name.toLowerCase() === targetFolder ||
          node.name.toLowerCase().includes(targetFolder) ||
          currentPath.some((seg) => seg.toLowerCase() === targetFolder)
        : true;

      const currentlyInTarget = inTargetFolder || folderMatches;

      for (const child of node.children) {
        traverse(child, currentPath, currentlyInTarget);
      }
      return;
    }

    // Leaf node: URL bookmark
    if (node.url && (targetFolder === undefined || inTargetFolder)) {
      const url = node.url.trim();
      // Only keep http and https
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return;
      }

      const dateAdded = parseChromeTime(node.date_added) ?? undefined;
      if (minDate && dateAdded && dateAdded < minDate) {
        return;
      }

      // Generate tags from folder path (excluding generic root folder names)
      const ignoredFolderNames = new Set([
        "bookmarks bar",
        "북마크바",
        "other bookmarks",
        "기타 북마크",
        "synced",
        "mobile bookmarks",
        "모바일 북마크",
      ]);

      const tags = pathArr
        .map((p) => p.trim())
        .filter((p) => p && !ignoredFolderNames.has(p.toLowerCase()))
        .slice(0, 5);

      results.push({
        url,
        title: node.name || url,
        folderPath: pathArr,
        dateAdded,
        tags,
      });
    }
  }

  for (const rootKey of Object.keys(data.roots || {})) {
    const rootNode = data.roots[rootKey];
    if (rootNode) traverse(rootNode, [], false);
  }

  return results;
}
