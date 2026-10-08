#!/bin/sh
# slop-hook runner, called from the pre-commit hook.
# Runs the checker, and in "ask" mode asks on the terminal when there is one.
# With no terminal (an editor's commit button, an AI agent), it warns and lets
# the commit through, so it can never hang.
# pwd -W gives a Windows path under Git for Windows, which native node needs.
DIR="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"

if ! command -v node >/dev/null 2>&1; then
  echo "slop-hook: node not found, skipping the AI tell check." >&2
  exit 0
fi

node "$DIR/slop-hook.mjs"
rc=$?

if [ "$rc" -eq 20 ]; then
  if (exec </dev/tty) 2>/dev/null && [ -t 2 ]; then
    printf "Commit anyway? [Y/n] " >&2
    read -r answer </dev/tty
    case "$answer" in
      [nN]*) echo "slop-hook: commit cancelled." >&2; exit 1 ;;
      *) exit 0 ;;
    esac
  fi
  echo "slop-hook: no terminal to ask, so the commit continues." >&2
  exit 0
fi

exit "$rc"
