# agent-harness:local — the Linux sandbox image the autonomous loop runs the
# builder (and any model-controlled command) inside. Built by:
#   docker build -t agent-harness:local .
#
# scripts/loop/sandbox.ts invokes this image with `--cap-drop ALL`,
# `--security-opt no-new-privileges`, a pids/memory/cpu cap, and the workspace
# bind-mounted at /workspace (control-plane scripts over-mounted read-only).
# The container therefore only needs the toolchain, never any privilege.
# `current-` is the official image's alias for the newest Node release. Pinning a
# major would freeze the sandbox behind the host the loop runs on, and the shipped
# scripts are TypeScript executed by native type stripping — a runtime feature that
# only moves forward.
FROM node:current-bookworm-slim

# health.sh is bash; the reviewer and codex shell out to git.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The typist/builder CLI. Auth is supplied at runtime by sandbox.ts, which
# passes OPENAI_API_KEY through (DEFAULT_ENV_ALLOW) or bind-mounts the host
# ~/.codex login state (HARNESS_MOUNT_CODEX_HOME) for account-based auth.
RUN npm install -g @openai/codex

WORKDIR /workspace

# docker run supplies the actual command (e.g. `codex exec …` or `node …`);
# this default just proves the image is wired correctly.
CMD ["node", "--version"]
