#!/bin/bash
# parallel-git-sync.sh
# Multi-repository parallel git sync wrapper for Linux/macOS.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_EXEC=$(which node || true)

if [ -z "$NODE_EXEC" ]; then
    echo -e "\033[31mError: node is not installed or not in PATH\033[0m"
    exit 1
fi

"$NODE_EXEC" "$SCRIPT_DIR/parallel-git-sync.mjs" "$@"
