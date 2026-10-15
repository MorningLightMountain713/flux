#!/bin/sh
# A client of the cluster through ENDPOINTS: one write a second, each outcome
# appended to /data/probe.log as "<epoch seconds> ok|fail <n>".
n=0
while true; do
  n=$((n + 1))
  if /usr/local/bin/etcdctl --endpoints="$ENDPOINTS" --dial-timeout=2s --command-timeout=5s \
    put "probe/$n" "$n" >/dev/null 2>/data/last-error; then
    echo "$(/bin/busybox date +%s) ok $n" >> /data/probe.log
  else
    echo "$(/bin/busybox date +%s) fail $n" >> /data/probe.log
  fi
  /bin/busybox sleep 1
done
