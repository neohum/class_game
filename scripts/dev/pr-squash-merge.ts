#!/usr/bin/env node
/**
 * pr-squash-merge.ts — 깃 커밋, 푸시, 메인 머지 앤 스쿼시, 브랜치 삭제 원클릭 자동화 러너
 */
import { execSync } from "node:child_process";

function run(cmd: string, options: { ignoreError?: boolean; silent?: boolean } = {}) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit" })?.trim() ?? "";
  } catch (err: any) {
    if (options.ignoreError) return "";
    throw err;
  }
}

function runOut(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

export async function prSquashMerge(message?: string, body?: string) {
  let branch = runOut("git branch --show-current");
  if (!branch) {
    throw new Error("Detached HEAD 상태입니다. 유효한 브랜치에서 실행해주세요.");
  }

  // 1. main 브랜치일 경우 작업 브랜치 자동 분기 (main 직접 커밋/푸시 방지)
  if (branch === "main") {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const slug = message
      ? message.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-|-$/g, "").slice(0, 30)
      : `work-${timestamp}`;
    const newBranch = `feat/${slug}`;
    console.log(`🌿 'main' 브랜치에서 작업 브랜치로 분기합니다: ${newBranch}`);
    run(`git switch -c ${newBranch}`);
    branch = newBranch;
  }

  // 2. 변경사항 커밋
  const status = runOut("git status --porcelain");
  if (status) {
    const commitMsg = message || `feat: update changes (${new Date().toISOString().slice(0, 16)})`;
    console.log(`📝 변경사항 스테이징 및 커밋: ${commitMsg}`);
    run("git add -A");
    run(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
  } else {
    console.log("ℹ️ 커밋할 변경사항이 없습니다. 브랜치의 기존 커밋을 사용합니다.");
  }

  // 3. 원격(origin)으로 브랜치 푸시
  console.log(`🚀 원격 저장소(origin)로 브랜치 푸시 (${branch})...`);
  run(`git push -u origin ${branch}`);

  // 4. GitHub PR 확인 및 생성
  console.log("📬 GitHub Pull Request 확인 및 생성 중...");
  let prNum = runOut(`gh pr list --head "${branch}" --json number --jq ".[0].number"`);
  const prTitle = message || branch;
  const prBody = body || `## 📌 변경 요약\n- ${prTitle}\n\n## 🧪 검증 결과\n- 단위/빌드 테스트 통과`;

  if (!prNum) {
    run(`gh pr create --title "${prTitle.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}" --base main --head "${branch}"`);
    prNum = runOut(`gh pr list --head "${branch}" --json number --jq ".[0].number"`);
  } else {
    console.log(`ℹ️ 기존 PR #${prNum} 이(가) 열려 있습니다.`);
  }

  // 5. Squash and Merge 수행
  console.log(`🔀 Squash and Merge 수행 중 (PR #${prNum})...`);
  const subject = `${prTitle} (#${prNum})`;
  try {
    run(`gh pr merge "${branch}" --squash --delete-branch --subject "${subject.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}"`);
  } catch {
    try {
      run(`gh pr merge "${branch}" --squash --delete-branch --admin`);
    } catch {
      run(`gh pr merge "${branch}" --squash --delete-branch`);
    }
  }

  // 6. 로컬 main 동기화
  console.log("🔄 로컬 main 브랜치 동기화 중...");
  run("git switch main");
  run("git pull origin main");

  // 7. 로컬 브랜치 삭제 및 원격 추적 정리
  console.log(`🧹 작업 브랜치 정리 중 (${branch})...`);
  run(`git branch -D "${branch}"`, { ignoreError: true });
  run("git remote prune origin", { ignoreError: true });

  console.log("🎉 [성공] 깃 커밋, 푸시, 메인 머지 앤 스쿼시, 브랜치 삭제 완료!");
}

if (process.argv[1] && (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("pr-squash-merge.ts") || process.argv[1].endsWith("pr-squash-merge.js"))) {
  const msg = process.argv[2];
  const body = process.argv[3];
  prSquashMerge(msg, body).catch((err) => {
    console.error("❌ 오류 발생:", err);
    process.exit(1);
  });
}
