/**
 * github.ts — Direct GitHub Starred & Repository Importer
 *
 * Imports starred repositories and user repositories directly from GitHub.
 * Uses GitHub CLI (`gh`) when available (zero setup, keyring authenticated),
 * falling back to GITHUB_TOKEN or public GitHub REST API endpoints.
 *
 * Invariants:
 * - Read-only: never alters user's GitHub stars, forks, or repositories.
 * - Redacts tokens from errors and output.
 * - Extracts topics, language, and descriptions as tags/notes.
 */

import { spawnSync } from "node:child_process";

export interface ExtractedGitHubRepo {
  url: string;
  name: string;
  fullName: string;
  description: string;
  language?: string;
  topics: string[];
  stars: number;
}

export interface DetectGitHubUserResult {
  username?: string;
  source: "gh" | "env" | "none";
}

/**
 * Detects the current active GitHub user from `gh` CLI or environment variables.
 */
export function detectGitHubUser(): DetectGitHubUserResult {
  // 1. Try gh CLI auth status / user
  try {
    const ghCheck = spawnSync("gh", ["api", "user", "-q", ".login"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (ghCheck.status === 0 && ghCheck.stdout.trim()) {
      return {
        username: ghCheck.stdout.trim(),
        source: "gh",
      };
    }
  } catch {
    // gh CLI not available
  }

  // 2. Check environment variables
  const envUser = process.env.GITHUB_USER || process.env.GITHUB_ACTOR;
  if (envUser && envUser.trim()) {
    return {
      username: envUser.trim(),
      source: "env",
    };
  }

  return {
    username: undefined,
    source: "none",
  };
}

/**
 * Fetches starred repositories from GitHub for a user.
 */
export async function fetchGitHubStarredRepos(options: {
  username?: string;
  limit?: number;
  token?: string;
} = {}): Promise<ExtractedGitHubRepo[]> {
  const limit = options.limit ?? 50;
  const detected = detectGitHubUser();
  const targetUser = options.username || detected.username;

  // Attempt 1: via `gh` CLI if installed
  if (detected.source === "gh" && !options.token) {
    try {
      const endpoint = options.username
        ? `users/${options.username}/starred?per_page=${Math.min(limit, 100)}`
        : `user/starred?per_page=${Math.min(limit, 100)}`;

      const ghRes = spawnSync("gh", ["api", endpoint], {
        encoding: "utf8",
        timeout: 15000,
      });

      if (ghRes.status === 0 && ghRes.stdout.trim()) {
        const rawList = JSON.parse(ghRes.stdout);
        if (Array.isArray(rawList)) {
          return mapGitHubRepos(rawList.slice(0, limit));
        }
      }
    } catch {
      // Fallback to fetch
    }
  }

  // Attempt 2: via REST API
  if (!targetUser) {
    throw new Error(
      "GitHub 사용자명을 확인할 수 없습니다. 사용자명을 입력하거나 'gh auth login'을 실행해주세요. (usage: ca import github <username>)"
    );
  }

  const token = options.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers: Record<string, string> = {
    "User-Agent": "create-agent-harness-knowledge/1.0",
    Accept: "application/vnd.github.v3+json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const url = `https://api.github.com/users/${encodeURIComponent(targetUser)}/starred?per_page=${Math.min(limit, 100)}`;
  const res = await fetch(url, { headers });

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`GitHub 사용자를 찾을 수 없습니다: ${targetUser}`);
    }
    if (res.status === 403 || res.status === 429) {
      throw new Error("GitHub API 요청 한도(Rate Limit)를 초과했습니다. GITHUB_TOKEN을 설정하거나 gh CLI로 로그인해주세요.");
    }
    throw new Error(`GitHub API 호출 실패 (상태 코드: ${res.status})`);
  }

  const rawList = await res.json();
  if (!Array.isArray(rawList)) {
    return [];
  }

  return mapGitHubRepos(rawList.slice(0, limit));
}

/**
 * Fetches repositories owned by a user from GitHub.
 */
export async function fetchGitHubUserRepos(options: {
  username?: string;
  limit?: number;
  token?: string;
} = {}): Promise<ExtractedGitHubRepo[]> {
  const limit = options.limit ?? 50;
  const detected = detectGitHubUser();
  const targetUser = options.username || detected.username;

  // Attempt 1: via `gh` CLI
  if (detected.source === "gh" && !options.token) {
    try {
      const endpoint = options.username
        ? `users/${options.username}/repos?per_page=${Math.min(limit, 100)}&sort=updated`
        : `user/repos?per_page=${Math.min(limit, 100)}&sort=updated`;

      const ghRes = spawnSync("gh", ["api", endpoint], {
        encoding: "utf8",
        timeout: 15000,
      });

      if (ghRes.status === 0 && ghRes.stdout.trim()) {
        const rawList = JSON.parse(ghRes.stdout);
        if (Array.isArray(rawList)) {
          return mapGitHubRepos(rawList.slice(0, limit));
        }
      }
    } catch {
      // Fallback
    }
  }

  // Attempt 2: via REST API
  if (!targetUser) {
    throw new Error(
      "GitHub 사용자명을 확인할 수 없습니다. 사용자명을 입력하거나 'gh auth login'을 실행해주세요."
    );
  }

  const token = options.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers: Record<string, string> = {
    "User-Agent": "create-agent-harness-knowledge/1.0",
    Accept: "application/vnd.github.v3+json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const url = `https://api.github.com/users/${encodeURIComponent(targetUser)}/repos?per_page=${Math.min(limit, 100)}&sort=updated`;
  const res = await fetch(url, { headers });

  if (!res.ok) {
    throw new Error(`GitHub API 호출 실패 (상태 코드: ${res.status})`);
  }

  const rawList = await res.json();
  if (!Array.isArray(rawList)) {
    return [];
  }

  return mapGitHubRepos(rawList.slice(0, limit));
}

function mapGitHubRepos(rawList: any[]): ExtractedGitHubRepo[] {
  return rawList
    .filter((item) => item && item.html_url)
    .map((item) => ({
      url: item.html_url,
      name: item.name || "",
      fullName: item.full_name || item.name || "",
      description: item.description || "",
      language: item.language || undefined,
      topics: Array.isArray(item.topics) ? item.topics : [],
      stars: typeof item.stargazers_count === "number" ? item.stargazers_count : 0,
    }));
}
