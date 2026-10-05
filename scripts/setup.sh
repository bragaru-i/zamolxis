#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 22 or newer, then rerun this command.' >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22 or newer is required"); process.exit(1); }'
if ! command -v pnpm >/dev/null 2>&1; then
  echo 'Install pnpm 10.17.1, then rerun this command.' >&2
  exit 1
fi
pnpm install --frozen-lockfile
exec pnpm zamolxis setup
