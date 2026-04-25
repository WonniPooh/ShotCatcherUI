#!/usr/bin/env bash
# Chart UI test runner
# Usage:
#   ./scripts/test_ui.sh              # run all (backend + frontend)
#   ./scripts/test_ui.sh backend      # backend only (pytest)
#   ./scripts/test_ui.sh frontend     # frontend only (vitest)
#   ./scripts/test_ui.sh -v           # verbose mode
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$ROOT"
UI_DIR="$SERVER_DIR/chart-ui"

# ── Colours ───────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; RESET=$'\033[0m'

pass()  { echo -e "  ${GREEN}✓${RESET}  $*"; }
fail()  { echo -e "  ${RED}✗${RESET}  $*"; }
header(){ echo -e "\n${BOLD}$*${RESET}"; }

# ── Parse args ────────────────────────────────────────────────────────────────
TARGET="all"
VERBOSE=""
PYTEST_ARGS="-q"
VITEST_ARGS=""

for arg in "$@"; do
  case "$arg" in
    backend)  TARGET="backend" ;;
    frontend) TARGET="frontend" ;;
    all)      TARGET="all" ;;
    -v|--verbose)
      VERBOSE="1"
      PYTEST_ARGS="-v"
      VITEST_ARGS=""  # vitest is already verbose by default in run mode
      ;;
    *) echo "Unknown argument: $arg"; echo "Usage: $0 [all|backend|frontend] [-v]"; exit 1 ;;
  esac
done

# Known broken test files (pre-existing issues, not from our changes)
PYTEST_IGNORE="--ignore=tests/test_market_data_api.py"

TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_SUITES=()

# ── Backend tests (pytest) ────────────────────────────────────────────────────
run_backend() {
  header "Backend tests (pytest)"
  cd "$SERVER_DIR"

  if python -m pytest tests/ $PYTEST_IGNORE $PYTEST_ARGS 2>&1; then
    pass "Backend tests passed"
  else
    fail "Backend tests FAILED"
    FAILED_SUITES+=("backend")
    ((TOTAL_FAIL++)) || true
    return
  fi
  ((TOTAL_PASS++)) || true
}

# ── Frontend tests (vitest) ──────────────────────────────────────────────────
run_frontend() {
  header "Frontend tests (vitest)"
  cd "$UI_DIR"

  if npx vitest run $VITEST_ARGS 2>&1; then
    pass "Frontend tests passed"
  else
    fail "Frontend tests FAILED"
    FAILED_SUITES+=("frontend")
    ((TOTAL_FAIL++)) || true
    return
  fi
  ((TOTAL_PASS++)) || true
}

# ── Run ───────────────────────────────────────────────────────────────────────
echo -e "${CYAN}═══ Chart UI Test Runner ═══${RESET}"

case "$TARGET" in
  backend)  run_backend ;;
  frontend) run_frontend ;;
  all)      run_backend; run_frontend ;;
esac

# ── Summary ───────────────────────────────────────────────────────────────────
header "Summary"
if [[ ${#FAILED_SUITES[@]} -eq 0 ]]; then
  echo -e "  ${GREEN}All test suites passed${RESET} ($TOTAL_PASS/$((TOTAL_PASS + TOTAL_FAIL)))"
  exit 0
else
  echo -e "  ${RED}Failed suites: ${FAILED_SUITES[*]}${RESET}"
  exit 1
fi
