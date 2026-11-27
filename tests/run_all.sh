#!/bin/sh
# Run the snailog test suites. Usage: tests/run_all.sh [server|api|e2e|visual]...
# (no argument = all of them, in that order). Exit code 1 if anything failed.
cd "$(dirname "$0")/.." || exit 1
groups="${*:-server api e2e visual}"
failed=""

run() {                      # run <label> <command...>
  label=$1; shift
  printf '\n### %s\n' "$label"
  if ! "$@"; then failed="$failed $label"; fi
}

for g in $groups; do
  case $g in
    server)
      run server/solanum python3 tests/server/test_solanum.py
      run server/soju python3 tests/server/test_soju.py
      run server/tls python3 tests/server/test_tls.py ;;
    api)
      for t in tests/api/test_*.py; do run "api/$(basename "$t" .py)" python3 "$t"; done ;;
    e2e)
      run e2e python3 tests/e2e/run.py ;;
    visual)
      run visual python3 tests/visual/run.py ;;
    *) echo "unknown group: $g"; exit 2 ;;
  esac
done

if [ -n "$failed" ]; then
  printf '\nFAILED:%s\n' "$failed"; exit 1
fi
printf '\nall passed\n'
