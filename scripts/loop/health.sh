#!/usr/bin/env bash
# health.sh — local verification gate for the autonomous loop.
#
# The Builder runs this between iterations. A non-zero exit means "not done" —
# the loop keeps iterating (up to its cap). A zero exit means the work unit is
# eligible for Reviewer sign-off.
#
# Tighten the checks here over weekend tuning sessions: the sharper this gate,
# the less low-quality code the agents can ever commit.
#
# Override any step with an env var; set to "true" to skip (no-op).
#   HEALTH_INSTALL   default: auto (pm install if node_modules missing)
#   HEALTH_LINT      default: auto (<pm> run lint if a "lint" script exists)
#   HEALTH_TYPECHECK default: auto (<pm> run typecheck if it exists)
#   HEALTH_TEST      default: auto (<pm> test)
#
# Exit codes: 0 = all gates pass. Non-zero = first failing gate's code.

set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1   # repo root

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit "${2:-1}"; }

# --- detect package manager ------------------------------------------------
if [ -f pnpm-lock.yaml ]; then PM=pnpm
elif [ -f yarn.lock ];    then PM=yarn
elif [ -f bun.lockb ];    then PM=bun
else PM=npm
fi

has_script() {
  [ -f package.json ] && node -e "process.exit(require('./package.json').scripts?.['$1']?0:1)" 2>/dev/null
}

run() {
  local name="$1"; shift
  step "$name: $*"
  if "$@"; then ok "$name"; else die "$name failed" $?; fi
}

# --- install (only if deps are missing) ------------------------------------
if [ "${HEALTH_INSTALL:-auto}" != "true" ] && [ -f package.json ] && [ ! -d node_modules ]; then
  if [ "${HEALTH_INSTALL:-auto}" = "auto" ]; then run "install" "$PM" install
  else run "install" bash -c "${HEALTH_INSTALL}"; fi
fi

# --- lint ------------------------------------------------------------------
if [ "${HEALTH_LINT:-auto}" = "auto" ]; then
  if has_script lint; then run "lint" "$PM" run lint; fi
elif [ "${HEALTH_LINT:-auto}" != "true" ]; then
  run "lint" bash -c "${HEALTH_LINT}"
fi

# --- typecheck -------------------------------------------------------------
if [ "${HEALTH_TYPECHECK:-auto}" = "auto" ]; then
  if has_script typecheck; then run "typecheck" "$PM" run typecheck; fi
elif [ "${HEALTH_TYPECHECK:-auto}" != "true" ]; then
  run "typecheck" bash -c "${HEALTH_TYPECHECK}"
fi

# --- test ------------------------------------------------------------------
if [ "${HEALTH_TEST:-auto}" = "auto" ]; then
  if has_script test; then run "test" "$PM" test
  else step "test: no test script — skipping (add one to tighten this gate)"; fi
elif [ "${HEALTH_TEST:-auto}" != "true" ]; then
  run "test" bash -c "${HEALTH_TEST}"
fi

ok "health: all gates passed"
