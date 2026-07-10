#!/usr/bin/env bash
# cross-build-wails.sh — cross-compile a Wails v3 desktop app for Windows, from Linux.
#
# WHY THIS EXISTS
# ---------------
# The autonomous loop runs on an always-on Linux box (the same server that hosts
# the agent legion, telemetry, and the telegram listener). The developer's
# Windows machine is NOT always on — it sleeps, it travels, it reboots. We do not
# want the Windows desktop build to depend on a machine that may be unreachable.
#
# So we turn the always-on Linux server into a Windows *build base*: it produces
# the shippable Windows .exe via cross-compilation. The dev's Windows box becomes
# a place to run/QA the artifact, not a build dependency. CI never blocks on it.
#
# HOW WINDOWS CROSS-COMPILATION WORKS HERE
# ----------------------------------------
# Go itself cross-compiles trivially with GOOS/GOARCH, but a Wails app links
# against C (webview2 glue, etc.), so we need a C cross-toolchain that targets
# Windows. We use the Zig compiler as that toolchain — `zig cc` is a drop-in,
# hermetic cross-compiler (no msys2/mingw apt soup to babysit). Wails v3 also
# embeds Windows resources (icon + manifest) into the binary via a .syso object,
# which go-winres generates from build/appicon.png.
#
# PREREQUISITES (this script DETECTS and GUIDES; it does not hard-fail)
#   - docker        : optional, only if you build inside the wails-cross image
#   - wails3 CLI    : github.com/wailsapp/wails/v3  (go install .../v3/cmd/wails3@latest)
#   - zig           : the C cross-toolchain  (https://ziglang.org/download)
#   - go-winres     : embeds icon/manifest    (go install github.com/tc-hib/go-winres@latest)
#
# This is a runnable SCAFFOLD. The target app may not exist yet, so every step is
# guarded and prints guidance. It exits 0 when prereqs/app are missing (so the
# loop is never broken by an environment that isn't set up yet) and only does
# real work once everything is present.

set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1   # repo root

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }
warn() { printf '\033[33m! %s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }

# --- build target --------------------------------------------------------------
GOOS_TARGET="windows"
GOARCH_TARGET="amd64"
APP_NAME="${APP_NAME:-app}"
OUT_DIR="${OUT_DIR:-bin}"
OUT_EXE="${OUT_DIR}/${APP_NAME}.exe"

# --- prerequisite detection (guidance only, never fatal) -----------------------
missing=0

check() {
  # check <command> <install-hint>
  local cmd="$1" hint="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$cmd found: $(command -v "$cmd")"
  else
    warn "$cmd not found"
    info "install: $hint"
    missing=$((missing + 1))
  fi
}

step "Checking prerequisites"
check docker    "https://docs.docker.com/engine/install/  (optional: only for the wails-cross image route)"
check wails3    "go install github.com/wailsapp/wails/v3/cmd/wails3@latest"
check zig       "download from https://ziglang.org/download/ and put 'zig' on PATH"
check go-winres "go install github.com/tc-hib/go-winres@latest"

# Optionally note the convenience docker image that bundles the toolchain.
if command -v docker >/dev/null 2>&1; then
  if docker image inspect wails-cross >/dev/null 2>&1; then
    ok "docker image 'wails-cross' present (toolchain bundled)"
  else
    info "docker image 'wails-cross' not built — you can either build that image"
    info "or install zig + go-winres on the host directly (either works)."
  fi
fi

# --- icon / resource binding explainer -----------------------------------------
# go-winres reads build/appicon.png and produces a multi-size icon.ico
# (16x16, 32x32, 48x48, 256x256) plus a manifest, then compiles them into a
# rsrc_windows_amd64.syso. The Go linker auto-picks up any *.syso next to main,
# so the resulting .exe carries a proper taskbar/Explorer icon and a Windows
# application manifest (DPI awareness, requested execution level, etc.).
APPICON="build/appicon.png"
step "Windows resource (icon + manifest) binding"
if [ -f "$APPICON" ]; then
  ok "$APPICON present"
  info "go-winres will generate: $APPICON -> icon.ico (16x16..256x256) -> *.syso"
  if command -v go-winres >/dev/null 2>&1; then
    info "canonical: go-winres make --in build/winres/winres.json --arch $GOARCH_TARGET"
    info "(or 'go-winres simply --icon $APPICON' to bootstrap from just the png)"
  fi
else
  warn "$APPICON not found — the exe would have no embedded icon/manifest"
  info "add a 256x256 PNG at $APPICON, then go-winres derives the .ico sizes"
fi

# --- app presence guard --------------------------------------------------------
# A Wails v3 app has main.go at the repo root (or a wails3 project layout).
step "Checking for a Wails app to build"
if [ ! -f "main.go" ] && [ ! -f "wails.json" ] && [ ! -f "Taskfile.yml" ]; then
  warn "no Wails app detected (no main.go / wails.json / Taskfile.yml at repo root)"
  info "This is expected on a fresh scaffold. Create the app first, e.g.:"
  info "  wails3 init -n $APP_NAME && cd $APP_NAME"
  info "Once the app exists, re-run this script to produce $OUT_EXE."
  echo
  ok "scaffold check complete — nothing to build yet (exiting 0 with guidance)"
  exit 0
fi

if [ "$missing" -gt 0 ]; then
  warn "$missing prerequisite(s) missing — cannot cross-build yet."
  info "Install the items flagged above, then re-run. Exiting 0 (guidance, not failure)."
  exit 0
fi

# --- the canonical cross-build invocation --------------------------------------
# Everything below only runs when an app AND all tools are present.
step "Cross-compiling for ${GOOS_TARGET}/${GOARCH_TARGET} via the Zig toolchain"

mkdir -p "$OUT_DIR"

# 1) (re)generate the Windows .syso so the exe carries icon + manifest.
if [ -f "$APPICON" ] && command -v go-winres >/dev/null 2>&1; then
  info "go-winres: embedding icon/manifest"
  go-winres simply --icon "$APPICON" || warn "go-winres failed (continuing without embedded resources)"
fi

# 2) Cross-compile. CGO is required for the webview glue, so point the C/C++
#    compiler at Zig's hermetic cross-toolchain targeting Windows.
#    Note: `zig cc -target x86_64-windows-gnu` produces a mingw-w64-compatible exe.
info "canonical invocation:"
info "  CGO_ENABLED=1 GOOS=$GOOS_TARGET GOARCH=$GOARCH_TARGET \\"
info "    CC=\"zig cc -target x86_64-windows-gnu\" \\"
info "    CXX=\"zig c++ -target x86_64-windows-gnu\" \\"
info "    go build -tags production -ldflags \"-H windowsgui -s -w\" -o $OUT_EXE ."

CGO_ENABLED=1 \
GOOS="$GOOS_TARGET" \
GOARCH="$GOARCH_TARGET" \
CC="zig cc -target x86_64-windows-gnu" \
CXX="zig c++ -target x86_64-windows-gnu" \
go build -tags production -ldflags "-H windowsgui -s -w" -o "$OUT_EXE" .
build_code=$?

if [ "$build_code" -eq 0 ] && [ -f "$OUT_EXE" ]; then
  ok "built $OUT_EXE"
  info "copy this artifact to the (sometimes-off) Windows box for run/QA."
else
  warn "cross-build did not complete (go build exit $build_code)"
  info "common cause: zig target mismatch or missing CGO deps — see output above."
  # Still exit 0: this scaffold reports rather than breaking the loop.
fi

exit 0
