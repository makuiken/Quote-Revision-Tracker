#!/usr/bin/env bash
# Run the end-to-end suite against the locally running app.
#
# Usage: ./run-e2e.sh   (or: pnpm --filter @workspace/e2e run test:e2e)
#
# Requires the "artifacts/quote-tracker: web" and "artifacts/api-server: API
# Server" workflows to be running (they are managed by Replit and normally
# always on). The suite talks to the shared proxy on localhost:80, which routes
# "/" to the web app and "/api" to the API server. Override with E2E_BASE_URL.
set -euo pipefail
cd "$(dirname "$0")"

BASE_URL="${E2E_BASE_URL:-http://localhost:80}"

check() {
  local path="$1" expect="$2" name="$3"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE_URL$path" || echo "000")
  if [ "$code" != "$expect" ]; then
    echo "ERROR: $name is not reachable at $BASE_URL$path (got HTTP $code, expected $expect)." >&2
    echo "Start the quote-tracker and api-server workflows, then re-run." >&2
    exit 1
  fi
}

check "/" 200 "quote-tracker web app"
check "/api/quotes" 401 "API server (401 = up, auth required)"

exec npx playwright test "$@"
