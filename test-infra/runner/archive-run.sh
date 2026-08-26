#!/usr/bin/env bash
# Archive one harness run: its log dir, its driver log, the per-test node logs, and
# the mongo profiler's dbwatch log if one was taken.
#
# Run it verbatim, and run it BEFORE anything clears /tmp — the next run's sweep
# takes the log dir, and a re-run cannot reproduce the evidence that mattered.
#
#   ./test-infra/runner/archive-run.sh <destination> [log-dir] [driver-log]
#
# <destination> is a directory name, conventionally <sha>-<what>-<verdict>, created
# under $ARCHIVE_ROOT (default /dat/e2e/quorum-grant-logs). log-dir defaults to
# $E2E_LOG_DIR then /tmp/e2e-logs; driver-log to <log-dir>/driver.log then /tmp/gate.log.
#
# WHY THIS IS A SCRIPT AND NOT A COMMAND IN A RUNBOOK. The obvious one-liner is a
# chain of `cp`s joined by `&&`, and it has two silent failure modes that between
# them cost the thing being archived:
#
#   1. A systemd node's journal is written by journald AS ROOT inside the container.
#      Until the teardown chown landed beside this script, `cp` as the invoking user
#      got Permission denied on every .journal file.
#   2. Because the steps were chained with `&&`, that first refusal ABANDONED the
#      rest — the driver log and the per-test node logs never got copied either. The
#      archive still existed, still looked plausible, and was missing most of itself.
#
# So: every step runs independently, every step reports, and a run that produced
# journals but archived none of them FAILS LOUDLY. Silence is the failure mode here
# — an empty capture reads exactly like a run with nothing to capture.
set -uo pipefail

DEST_NAME="${1:-}"
LOG_DIR="${2:-${E2E_LOG_DIR:-/tmp/e2e-logs}}"
ARCHIVE_ROOT="${ARCHIVE_ROOT:-/dat/e2e/quorum-grant-logs}"

if [ -z "$DEST_NAME" ]; then
  echo "usage: $0 <destination-name> [log-dir] [driver-log]" >&2
  echo "       e.g. $0 81ff3f03e-fullgate-green" >&2
  exit 2
fi
if [ ! -d "$LOG_DIR" ]; then
  echo "ARCHIVE-FAIL no log dir at $LOG_DIR" >&2
  exit 1
fi

DRIVER_LOG="${3:-}"
if [ -z "$DRIVER_LOG" ]; then
  for c in "$LOG_DIR/driver.log" /tmp/gate.log; do
    [ -f "$c" ] && { DRIVER_LOG="$c"; break; }
  done
fi

DEST="$ARCHIVE_ROOT/$DEST_NAME"
if [ -e "$DEST" ]; then
  echo "ARCHIVE-FAIL $DEST already exists — pick another name rather than merging two runs" >&2
  exit 1
fi

# sudo throughout, non-interactively: the journals are root-owned until the teardown
# chown has run, and an archive taken from a killed run never got that teardown. A
# box without passwordless sudo says so here instead of producing a partial archive.
S=""
if ! sudo -n true 2>/dev/null; then
  echo "ARCHIVE-WARN no non-interactive sudo; root-owned journals may not copy" >&2
else
  S="sudo -n"
fi

$S mkdir -p "$DEST" || { echo "ARCHIVE-FAIL cannot create $DEST" >&2; exit 1; }

# Independent steps. Each reports; none can abandon the ones after it.
fails=0
step() {  # step <label> <src> <dst>
  local label="$1" src="$2" dst="$3"
  if [ ! -e "$src" ]; then
    echo "  skip  $label (no $src)"
    return 0
  fi
  if $S cp -r "$src" "$dst"; then
    echo "  ok    $label"
  else
    echo "  FAIL  $label ($src)" >&2
    fails=$((fails + 1))
  fi
}

echo "archiving $LOG_DIR -> $DEST"
step "log dir"       "$LOG_DIR"                                    "$DEST/e2e-logs"
[ -n "$DRIVER_LOG" ] && step "driver log" "$DRIVER_LOG" "$DEST/driver.log"
step "per-test logs" "$(dirname "$0")/test-logs"                   "$DEST/test-logs"
# No dbwatch step. A gate does not produce one and never did: db-watch.js watches a
# SINGLE node at a few samples a second, which is a targeted-investigation instrument,
# not a gate one. Copying "if present" here implied a gate ought to have it and made
# four gates read as though something had gone missing.

[ -n "$S" ] && $S chown -R "$(id -u):$(id -g)" "$DEST"

# The check that makes the archive worth taking: journals in, journals out. A run
# with systemd nodes writes journal-<network>-<NN> directories into the log dir; if
# any exist and none arrived, this archive is missing the only record a node that
# died at boot ever leaves, and saying so now is the whole point.
src_j=$(find "$LOG_DIR" -maxdepth 2 -type d -name 'journal-*' 2>/dev/null | wc -l | tr -d ' ')
dst_f=$(find "$DEST" -name '*.journal' 2>/dev/null | wc -l | tr -d ' ')
if [ "$src_j" -gt 0 ] && [ "$dst_f" -eq 0 ]; then
  echo "ARCHIVE-FAIL $src_j journal dir(s) in the run, 0 .journal files archived — the systemd nodes' only record did not come across" >&2
  fails=$((fails + 1))
fi

size=$(du -sh "$DEST" 2>/dev/null | cut -f1)
echo "captured: ${size:-?}, journal dirs=$src_j journal files=$dst_f"

if [ "$fails" -gt 0 ]; then
  echo "ARCHIVE-INCOMPLETE $DEST ($fails step(s) failed)" >&2
  exit 1
fi
echo "ARCHIVE-OK $DEST"
