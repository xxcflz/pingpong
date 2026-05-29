#!/usr/bin/env bash
#
# cloudflared.sh — Quick tunnel for local development
#
# Exposes the Vite dev server (localhost:5173) via a Cloudflare quick tunnel.
# The printed URL goes into Discord Developer Portal → URL Mappings.
#
# Usage:
#   bash infra/cloudflared.sh
#
# Requires: cloudflared (brew install cloudflared / apt install cloudflared)

set -euo pipefail

PORT="${VITE_PORT:-5173}"

echo ">> Exposing http://localhost:${PORT} via cloudflared quick tunnel..."
echo ">> Copy the https://*.trycloudflare.com URL into Discord Developer Portal → URL Mappings."
echo ""

exec cloudflared tunnel --url "http://localhost:${PORT}"
