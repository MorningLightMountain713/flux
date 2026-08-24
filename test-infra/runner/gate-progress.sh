#!/usr/bin/env bash
# One status line for a gate driver log: whether it is running, and how it ended.
#
# Run it verbatim. Every count below has been checked against FINISHED logs in
# both directions - a green one and one with a known red - and against each
# truncated on either side of its first failure, so the running state is known
# to flip exactly where the failure lands. A monitor written from the prose in
# INTEGRATION_HARNESS_CINDY.md instead of from this file has twice reported a
# healthy gate for an hour while a suite was already red.
#
#   ./test-infra/runner/gate-progress.sh [driver.log]
#
# Defaults to $E2E_LOG_DIR/driver.log, then /tmp/e2e-logs/driver.log.
#
# The spacing in the runner's output is PADDING, not single spaces: `DONE` is
# followed by four and `RESULT` by two. Every pattern here matches ` +` so a
# change to the padding cannot silently stop it matching - a pattern that
# matches nothing reports "0 failed" forever, which reads exactly like a healthy
# gate.
set -uo pipefail

LOG="${1:-${E2E_LOG_DIR:-/tmp/e2e-logs}/driver.log}"

if [ ! -f "$LOG" ]; then
  echo "NOLOG $LOG"
  exit 0
fi

result=$(grep -oE 'RESULT +suites_pass=[0-9]+ suites_fail=[0-9]+' "$LOG" | tail -1)
failed_list=$(grep -oE 'FAILED:\[[^]]*\]' "$LOG" | tail -1)

# PAR-DONE is the terminator. A log carrying it but no RESULT means the runner
# died between the two, which must not be reported as still running.
if grep -q 'PAR-DONE' "$LOG"; then
  if [ -z "$result" ]; then
    echo "FINISHED-NO-RESULT :: the runner ended without a RESULT line :: ${failed_list:-no-failed-list}"
    exit 0
  fi
  fail_n=$(echo "$result" | grep -oE 'suites_fail=[0-9]+' | cut -d= -f2)
  if [ "$fail_n" = "0" ]; then
    echo "GREEN :: $result"
  else
    echo "RED :: $result :: ${failed_list:-no-failed-list}"
  fi
  exit 0
fi

# Still running. `rc=` carries the verdict for a finished suite; the word
# "failed" appears on passing lines too, as "failed:[ ]", so it is not the thing
# to match on.
done_n=$(grep -cE 'DONE +suite' "$LOG")
fail_n=$(grep -cE 'DONE +suite [0-9]+ rc=[1-9]' "$LOG")
launched_n=$(grep -cE 'LAUNCH +suite' "$LOG")
inflight=$(grep -oE 'inflight=[0-9]+' "$LOG" | tail -1)

if [ "$fail_n" -gt 0 ]; then
  # Named as they land rather than at the end, so a red gate is not a surprise
  # an hour in.
  names=$(grep -E 'DONE +suite [0-9]+ rc=[1-9]' "$LOG" | grep -oE 'suite [0-9]+' | awk '{print $2}' | tr '\n' ' ')
  echo "RUNNING :: launched=${launched_n} done=${done_n} FAILED-SO-FAR=[ ${names}] :: ${inflight:-inflight=?}"
else
  echo "RUNNING :: launched=${launched_n} done=${done_n} no-failures-yet :: ${inflight:-inflight=?}"
fi
