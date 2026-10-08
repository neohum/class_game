#!/usr/bin/env node
/**
 * batch-harness-propagate.mjs
 * 
 * High-concurrency automated harness propagation engine across downstream repositories.
 * Updates .harness-version.json to v0.4.44, merges JSON configs, installs workspace-sync-all skill,
 * commits, pushes with ALLOW_PUSH=1, creates GitHub PR, squash-merges, and deletes the branch.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_ROOT = path.resolve(__dirname, '../..');
const WORKS_ROOT = path.resolve(HARNESS_ROOT, '..');
const CREATE_SCRIPT = path.join(HARNESS_ROOT, 'bin', 'create.ts');
const TARGET_VERSION = '0.4.44';

function run(cmd, args, cwd = process.cwd(), timeoutMs = 45000) {
  try {
    const res = spawnSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      env: { ...process.env, ALLOW_PUSH: '1' },
    });
    return {
      ok: res.status === 0,
      out: ((res.stdout || '') + (res.stderr || '')).trim(),
      code: res.status ?? 1,
    };
  } catch (err) {
    return { ok: false, out: err.message || String(err), code: 1 };
  }
}

function getRepoInfo(targetDir) {
  const versionFile = path.join(targetDir, '.harness-version.json');
  if (!fs.existsSync(versionFile)) return null;

  let currentVersion = 'unknown';
  try {
    const data = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    currentVersion = data.version || 'unknown';
  } catch {}

  const gitDir = path.join(targetDir, '.git');
  if (!fs.existsSync(gitDir)) return null;

  const remoteRes = run('git', ['remote', 'get-url', 'origin'], targetDir);
  if (!remoteRes.ok || !remoteRes.out) return null;

  return {
    path: targetDir,
    name: path.basename(targetDir),
    version: currentVersion,
    remote: remoteRes.out.trim(),
  };
}

async function syncSingleProject(repo) {
  console.log(`\n------------------------------------------------------------`);
  console.log(`🚀 [${repo.name}] v${repo.version} ➔ v${TARGET_VERSION}`);

  // 1. Fail-closed check if working tree is dirty
  const dirtyRes = run('git', ['status', '--porcelain'], repo.path);
  if (!dirtyRes.ok || dirtyRes.out.length > 0) {
    console.warn(`   ⚠️ [${repo.name}] 작업 트리에 변경사항(dirty)이 있어 안전을 위해 건너뜁니다.`);
    return { name: repo.name, success: false, reason: 'dirty-working-tree' };
  }

  // 2. Ensure on main/master and fast-forward pull
  const branchRes = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo.path);
  const currentBranch = branchRes.ok ? branchRes.out.trim() : 'main';
  const mainBranch = (currentBranch === 'master') ? 'master' : 'main';

  if (currentBranch !== mainBranch) {
    run('git', ['checkout', mainBranch], repo.path);
  }
  run('git', ['pull', '--ff-only', 'origin', mainBranch], repo.path);

  // 3. Execute non-destructive harness update
  const updateRes = run(process.execPath, [CREATE_SCRIPT, repo.path, '--update', '--no-install'], repo.path);
  if (!updateRes.ok) {
    console.error(`   ❌ [${repo.name}] 하네스 업데이트 실패: ${updateRes.out}`);
    return { name: repo.name, success: false, reason: 'update-failed', error: updateRes.out };
  }

  // 4. Check if there are changes to commit
  const changesRes = run('git', ['status', '--porcelain'], repo.path);
  if (!changesRes.ok || changesRes.out.length === 0) {
    console.log(`   ✨ [${repo.name}] 변경사항 없음 (이미 최신 상태)`);
    return { name: repo.name, success: true, reason: 'already-up-to-date' };
  }

  // 5. Create feature branch, commit, push, PR squash-merge, and delete branch
  const branchName = `chore/harness-sync-v${TARGET_VERSION}`;
  run('git', ['checkout', '-B', branchName], repo.path);
  run('git', ['add', '-A'], repo.path);

  const commitMsg = `chore(harness): update agent-harness to v${TARGET_VERSION}\n\nAd-hoc: sync workspace-sync-all skill and harness engine v${TARGET_VERSION}`;
  const commitRes = run('git', ['commit', '-m', commitMsg], repo.path);
  if (!commitRes.ok) {
    console.error(`   ❌ [${repo.name}] 커밋 실패: ${commitRes.out}`);
    run('git', ['checkout', mainBranch], repo.path);
    return { name: repo.name, success: false, reason: 'commit-failed' };
  }

  const pushRes = run('git', ['push', '-u', 'origin', branchName, '--force'], repo.path);
  if (!pushRes.ok) {
    console.error(`   ❌ [${repo.name}] 푸시 실패: ${pushRes.out}`);
    run('git', ['checkout', mainBranch], repo.path);
    return { name: repo.name, success: false, reason: 'push-failed' };
  }

  // 6. Create PR via GitHub CLI
  const prCreateRes = run('gh', [
    'pr', 'create',
    '--head', branchName,
    '--base', mainBranch,
    '--title', `chore(harness): update agent-harness to v${TARGET_VERSION}`,
    '--body', `## 📌 하네스 자동 동기화\n- create-agent-harness v${TARGET_VERSION} 적용\n- workspace-sync-all 스킬 및 멀티 리포 깃 동기화 스크립트 반영`,
  ], repo.path);

  let prUrl = prCreateRes.out.trim();
  console.log(`   🔗 [${repo.name}] PR 생성: ${prUrl}`);

  // 7. Squash and merge PR
  const mergeRes = run('gh', [
    'pr', 'merge', branchName,
    '--squash', '--delete-branch',
    '--subject', `chore(harness): update agent-harness to v${TARGET_VERSION}`,
  ], repo.path);

  if (mergeRes.ok) {
    console.log(`   ✅ [${repo.name}] PR Squash Merge 완료 및 브랜치 삭제`);
  } else {
    console.warn(`   ⚠️ [${repo.name}] PR 자동 머지 실패 (${mergeRes.out}); PR 유지`);
  }

  // 8. Clean up local repository
  run('git', ['checkout', mainBranch], repo.path);
  run('git', ['pull', 'origin', mainBranch], repo.path);
  run('git', ['branch', '-D', branchName], repo.path);
  run('git', ['fetch', '--prune', 'origin'], repo.path);

  return { name: repo.name, success: true, prUrl };
}

async function main() {
  const args = process.argv.slice(2);
  const targetFilter = args.filter((a) => !a.startsWith('-'));

  const entries = fs.readdirSync(WORKS_ROOT, { withFileTypes: true });
  const allRepos = [];

  for (const ent of entries) {
    if (ent.isDirectory() && ent.name !== 'create-agent-harness') {
      const fullPath = path.join(WORKS_ROOT, ent.name);
      const repo = getRepoInfo(fullPath);
      if (repo) {
        if (targetFilter.length === 0 || targetFilter.includes(repo.name)) {
          allRepos.push(repo);
        }
      }
    }
  }

  console.log(`============================================================`);
  console.log(`🚀 전체 하네스 일괄 동기화 (총 ${allRepos.length}개 저장소 대상)`);
  console.log(`   목표 버전: v${TARGET_VERSION}`);
  console.log(`============================================================`);

  const results = [];
  // Process in batches of 3
  const CONCURRENCY = 3;
  for (let i = 0; i < allRepos.length; i += CONCURRENCY) {
    const chunk = allRepos.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map((repo) => syncSingleProject(repo)));
    results.push(...chunkResults);
  }

  console.log(`\n================== [동기화 최종 결과] ==================`);
  for (const r of results) {
    const icon = r.success ? '✅' : '❌';
    console.log(`${icon} ${r.name.padEnd(25)} : ${r.reason || 'SUCCESS'} ${r.prUrl ? `(${r.prUrl})` : ''}`);
  }
  console.log(`============================================================\n`);
}

main().catch((err) => {
  console.error('Fatal error during propagation:', err);
  process.exit(1);
});
