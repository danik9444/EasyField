#!/usr/bin/env bash
# Build a verified release, stage only manifest-listed plugin files, then swap it
# atomically into Resolve after macOS administrator approval.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "==> Verifying Resolve and Blackmagic's native Workflow Integration module"
"$PROJECT_DIR/packaging/pkg/scripts/preinstall"

echo "==> Building panel UI (vite build -> plugin/ui)"
cd "$PROJECT_DIR"
npm run plugin:build

if [ ! -f "$PROJECT_DIR/plugin/ui/index.html" ]; then
  echo "ERROR: plugin/ui/index.html missing — the UI build did not produce output." >&2
  exit 1
fi
node scripts/plugin-install-release.mjs

echo ""
echo "==> EasyField is ready."
echo "    Next steps:"
echo "      1. Restart DaVinci Resolve (Studio)."
echo "      2. Workspace > Workflow Integrations > EasyField."
