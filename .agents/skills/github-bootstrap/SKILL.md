---
name: github-bootstrap
description: Create or repair an autonomous harness project's first private GitHub repository, GitHub CLI authentication, main branch, initial commit, origin push, and bootstrap status. Use when a project has no origin, GitHub credentials are invalid, or automatic private-repository bootstrap is not progressing.
---

# GitHub Bootstrap

Use this only for a project the user has authorized to publish as a private GitHub repository.

1. Check `gh auth status -h github.com` and `git remote get-url origin`.
2. Never search arbitrary folders or print tokens. If the user supplies a trusted GitHub CLI config directory, set `HARNESS_GH_CONFIG_DIR` to it; the harness passes it only to `gh` as `GH_CONFIG_DIR`.
3. If authentication fails, run `gh auth login -h github.com` and let the user complete browser approval. Re-check status.
4. Run `node bin/create.ts . --update` for a self-hosted harness, or the project-local create command. `github.autoBootstrap: true` creates the first private origin only when none exists.
5. Verify `git branch --show-current` is `main`, `git remote get-url origin` succeeds, and `git status --short` is understood. The bootstrap converts an origin-less `master` branch to `main` before its first push.
6. Do not force-push, replace an existing origin, or commit secrets. A backlog-free Factory has no work commits; that is normal.
