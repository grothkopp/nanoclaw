#!/bin/bash
set -e

# --- Credential setup via proxy ---
# All secrets are fetched from the host's credential proxy at boot time.
# They exist only in memory (env vars or tmpfs), never in bind mounts.

INSTANCE_PARAM=""
if [ -n "$NANOCLAW_INSTANCE" ]; then
  INSTANCE_PARAM="?instance=$NANOCLAW_INSTANCE"
fi

# GitHub: git credential helper fetches tokens on-demand from the proxy.
# gh CLI uses a wrapper that does the same. No token in environment.
GH_CHECK=$(curl -sf "${CREDENTIAL_PROXY}/_cred/github${INSTANCE_PARAM}" 2>/dev/null || true)
if [ -n "$GH_CHECK" ]; then
  git config --global credential.helper /usr/local/bin/git-credential-proxy
  git config --global user.name "Sven"
  git config --global user.email "sven@nanoclaw"
fi
unset GH_CHECK

# Home Assistant: expose a convenience URL with instance baked in.
# Format: /_proxy/ha@{instance}/path — the proxy resolves per-instance secrets.
if [ -n "$NANOCLAW_INSTANCE" ]; then
  export HA_URL="${CREDENTIAL_PROXY}/_proxy/ha@${NANOCLAW_INSTANCE}"
else
  export HA_URL="${CREDENTIAL_PROXY}/_proxy/ha"
fi

# Google Workspace: credentials are fetched on-demand by the gws wrapper.
# The real credentials file only exists for the duration of each gws command.
export GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/gws-config
export GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file

# --- Build agent runner ---
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# --- Run agent ---
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
