package main

import (
	"context"

	"dagger/harness-ci/internal/dagger"
)

// HarnessCI exposes deterministic validation only. Publishing and deployment
// stay in the harness release policy, behind its evidence and approval gates.
type HarnessCI struct{}

func (m *HarnessCI) checkEnv(source *dagger.Directory) *dagger.Container {
	return dag.Container().
		From("node:22.18-bookworm-slim").
		WithDirectory("/src", source).
		WithWorkdir("/src").
		WithExec([]string{"npm", "ci"})
}

// Validate runs the same lockfile-based checks locally and in CI.
// +check
func (m *HarnessCI) Validate(
	ctx context.Context,
	// +optional
	// +defaultPath="/"
	// +ignore=[".git", "node_modules", "evidence", ".harness"]
	source *dagger.Directory,
) error {
	_, err := m.checkEnv(source).
		WithExec([]string{"npm", "run", "typecheck"}).
		WithExec([]string{"npm", "test"}).
		Sync(ctx)
	return err
}
