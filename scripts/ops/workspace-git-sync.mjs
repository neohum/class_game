#!/usr/bin/env node
/**
 * workspace-git-sync.mjs
 * 
 * Multi-repo Git & GitHub synchronization engine for edulinker-project ecosystem.
 * Supports:
 *   --check  : Read-only inspection of branches, dirty working trees, ahead/behind status, and open PRs.
 *   --pull   : Safe fast-forward pull only on clean main/master branches (Fail-Closed on dirty trees).
 *   --json   : Output machine-readable JSON status summary.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamically determine WORKS_ROOT
const SCRIPT_DIR = __dirname;
const PARENT_1 = path.resolve(SCRIPT_DIR, '../..');
const PARENT_2 = path.resolve(PARENT_1, '..');
const WORKS_ROOT = fs.existsSync(path.join(PARENT_2, 'create-agent-harness'))
  ? PARENT_2
  : fs.existsSync(path.join(PARENT_1, 'create-agent-harness'))
    ? PARENT_1
    : path.resolve(SCRIPT_DIR, '../../..');

const EDULINKER_ROOT = path.join(WORKS_ROOT, 'edulinker_v2');

// Primary ecosystem repositories
const ECOSYSTEM_REPOS = [
  { id: 'create-agent-harness', path: path.join(WORKS_ROOT, 'create-agent-harness') },
  { id: 'edulinker_v2', path: EDULINKER_ROOT, isRoot: true },
  { id: 'edulinker_v2/sync-server', path: path.join(EDULINKER_ROOT, 'sync-server') },
  { id: 'edulinker_v2/web_service', path: path.join(EDULINKER_ROOT, 'web_service') },
  { id: 'edulinker_v2/admin-web', path: path.join(EDULINKER_ROOT, 'admin-web') },
  { id: 'edulinker_v2/qbank-service', path: path.join(EDULINKER_ROOT, 'qbank-service') },
  { id: 'edulinker_v2/web-student', path: path.join(EDULINKER_ROOT, 'web-student') },
  { id: 'all_market', path: path.join(WORKS_ROOT, 'all_market') },
  { id: 'cloud-school', path: path.join(WORKS_ROOT, 'cloud-school') },
  { id: 'edulinker-vec', path: path.join(WORKS_ROOT, 'edulinker-vec') },
  { id: 'co-working', path: path.join(WORKS_ROOT, 'co-working') },
  { id: 'auto-school-work', path: path.join(WORKS_ROOT, 'auto-school-work') },
  { id: 'paper-cutting-ui', path: path.join(WORKS_ROOT, 'paper-cutting-ui') },
];

function runGit(cwd, args) {
  try {
    const res = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      env: { ...process.env, ALLOW_PUSH: '1' },
    });
    return {
      success: res.status === 0,
      stdout: (res.stdout || '').trim(),
      stderr: (res.stderr || '').trim(),
    };
  } catch (err) {
    return { success: false, stdout: '', stderr: String(err) };
  }
}

function runGh(cwd, args) {
  try {
    const res = spawnSync('gh', args, {
      cwd,
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    return {
      success: res.status === 0,
      stdout: (res.stdout || '').trim(),
      stderr: (res.stderr || '').trim(),
    };
  } catch {
    return { success: false, stdout: '', stderr: '' };
  }
}

function inspectRepo(repo) {
  if (!fs.existsSync(repo.path)) {
    return null;
  }
  const gitDir = path.join(repo.path, '.git');
  if (!fs.existsSync(gitDir)) {
    return null;
  }

  const branchRes = runGit(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headRes = runGit(repo.path, ['rev-parse', '--short', 'HEAD']);
  const statusRes = runGit(repo.path, ['status', '--porcelain']);
  const remoteRes = runGit(repo.path, ['remote']);

  const branch = branchRes.stdout || 'unknown';
  const head = headRes.stdout || 'unknown';
  const dirty = Boolean(statusRes.stdout);
  const dirtyFiles = statusRes.stdout ? statusRes.stdout.split('\n').filter(Boolean) : [];
  const hasRemote = Boolean(remoteRes.stdout);

  // Fetch quietly if remote exists
  let ahead = 0;
  let behind = 0;
  let remoteSynced = true;

  if (hasRemote) {
    runGit(repo.path, ['fetch', '--quiet', 'origin']);
    const revList = runGit(repo.path, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`]);
    if (revList.success && revList.stdout) {
      const parts = revList.stdout.split(/\s+/);
      behind = parseInt(parts[0], 10) || 0;
      ahead = parseInt(parts[1], 10) || 0;
      if (ahead > 0 || behind > 0) remoteSynced = false;
    }
  }

  // Open PR check on current branch if not main
  let openPr = null;
  if (branch !== 'main' && branch !== 'master' && hasRemote) {
    const prRes = runGh(repo.path, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,title,url']);
    if (prRes.success && prRes.stdout) {
      try {
        const prList = JSON.parse(prRes.stdout);
        if (prList.length > 0) {
          openPr = prList[0];
        }
      } catch {}
    }
  }

  return {
    id: repo.id,
    path: repo.path,
    branch,
    head,
    dirty,
    dirtyCount: dirtyFiles.length,
    dirtySample: dirtyFiles.slice(0, 3).map((f) => f.trim()),
    hasRemote,
    ahead,
    behind,
    remoteSynced,
    openPr,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isPull = args.includes('--pull');
  const isJson = args.includes('--json');
  const isHelp = args.includes('--help') || args.includes('-h');

  if (isHelp) {
    console.log(`
Usage: node scripts/ops/workspace-git-sync.mjs [options]

Options:
  --check   (default) Inspect branches, dirty status, ahead/behind, and PRs across all repos.
  --pull    Safely fast-forward pull clean main/master branches (Fail-Closed on dirty trees).
  --json    Output machine-readable JSON status summary.
  --help    Show this help message.
`);
    process.exit(0);
  }

  const results = [];
  for (const repo of ECOSYSTEM_REPOS) {
    const info = inspectRepo(repo);
    if (info) {
      results.push(info);
    }
  }

  if (isJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log('\n======================================================================');
  console.log('  🔍 edulinker-project Ecosystem Git & GitHub Workspace Status');
  console.log('======================================================================\n');

  let dirtyCountTotal = 0;
  let branchCountTotal = 0;
  let pullSuccessCount = 0;

  for (const r of results) {
    const isMain = r.branch === 'main' || r.branch === 'master';
    const statusIcon = r.dirty ? '⚠️ DIRTY' : (r.remoteSynced ? '✅ SYNCED' : '🔄 OUT-OF-SYNC');
    const branchDisplay = isMain ? r.branch : `🌿 ${r.branch}`;

    console.log(`📦 \x1b[1m${r.id.padEnd(26)}\x1b[0m | Branch: \x1b[36m${branchDisplay.padEnd(16)}\x1b[0m (${r.head}) | ${statusIcon}`);

    if (r.dirty) {
      dirtyCountTotal++;
      console.log(`   └─ ⚠️  Uncommitted Changes (${r.dirtyCount} files): ${r.dirtySample.join(', ')}`);
    }

    if (!isMain) {
      branchCountTotal++;
      if (r.openPr) {
        console.log(`   └─ 🔗 Open PR #${r.openPr.number}: "${r.openPr.title}" (${r.openPr.url})`);
      } else {
        console.log(`   └─ 💡 Feature branch without open PR. Ready for PR create & squash-merge.`);
      }
    }

    if (r.hasRemote && (r.ahead > 0 || r.behind > 0)) {
      console.log(`   └─ ⬆️  Ahead: ${r.ahead} commits | ⬇️ Behind: ${r.behind} commits`);
    }

    // Safe Pull Execution
    if (isPull) {
      if (isMain && !r.dirty && r.behind > 0) {
        process.stdout.write(`   └─ 🚀 Safe Fast-Forward Pulling... `);
        const pullRes = runGit(r.path, ['pull', '--ff-only', 'origin', r.branch]);
        if (pullRes.success) {
          console.log(`\x1b[32mSuccess\x1b[0m`);
          pullSuccessCount++;
        } else {
          console.log(`\x1b[31mFailed (${pullRes.stderr})\x1b[0m`);
        }
      } else if (r.dirty && r.behind > 0) {
        console.log(`   └─ 🛑 \x1b[33mFail-Closed: Working tree is DIRTY. Pull skipped to prevent merge conflicts.\x1b[0m`);
      }
    }
    console.log('');
  }

  console.log('----------------------------------------------------------------------');
  console.log(`📊 Total Repos: ${results.length} | Dirty Repos: ${dirtyCountTotal} | Feature Branches: ${branchCountTotal}`);

  if (dirtyCountTotal > 0 || branchCountTotal > 0) {
    console.log('\n💡 \x1b[33m안내: 미정리 브랜치나 변경 사항이 감지되었습니다.\x1b[0m');
    console.log('   PR 생성, 스쿼시 머지 및 브랜치 정리를 원하시면 에이전트 세션에서');
    console.log('   \x1b[1m/workspace-sync-all\x1b[0m 스킬을 호출하세요.\n');
  } else {
    console.log('\n✨ \x1b[32m모든 저장소가 깨끗한 main 브랜치와 완벽히 동기화되어 있습니다!\x1b[0m\n');
  }
}

main().catch((err) => {
  console.error('Error running workspace git sync:', err);
  process.exit(1);
});
