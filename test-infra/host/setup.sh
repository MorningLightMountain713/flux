#!/bin/sh
# Prepares a box to run the harness: run as root from a checkout,
#   sudo sh test-infra/host/setup.sh
# on a fresh box and again whenever this directory changes. Every step is idempotent.
set -eu
here=$(cd "$(dirname "$0")" && pwd)

# A node container holds more inotify instances than the default 128 allows; past it the
# container dies at boot with exit 255.
echo 'fs.inotify.max_user_instances=1024' > /etc/sysctl.d/99-flux-e2e-inotify.conf
# A fleet's bridge networks hold more neighbours than the default tables keep.
printf 'net.ipv4.neigh.default.gc_thresh1=2048\nnet.ipv4.neigh.default.gc_thresh2=4096\nnet.ipv4.neigh.default.gc_thresh3=8192\n' \
	> /etc/sysctl.d/99-flux-e2e-neigh.conf
sysctl -q --system

# On a VM whose hypervisor takes back free memory (virtio-balloon free page reporting), free
# memory is reported in 32 KiB blocks instead of 2 MiB ones. What a run frees - the mongo
# snapshot cache, fleet tmpfs, page cache - is scattered, and at the default size almost none
# of it reaches the hypervisor. Nothing reads it on a machine without a balloon device.
reporting=/sys/module/page_reporting/parameters/page_reporting_order
echo "w $reporting - - - - 3" > /etc/tmpfiles.d/flux-e2e-page-reporting.conf
if [ -w "$reporting" ]; then echo 3 > "$reporting"; fi

# Hourly, page cache is dropped, which with the reporting above returns it to the hypervisor.
echo '@hourly root sync && echo 3 > /proc/sys/vm/drop_caches' > /etc/cron.d/flux-e2e-drop-caches
# Daily, Docker's leftovers from finished runs are removed (upkeep.sh).
install -m 0755 "$here/upkeep.sh" /usr/local/sbin/flux-e2e-upkeep
echo '17 4 * * * root /usr/local/sbin/flux-e2e-upkeep 2>&1 | logger -t flux-e2e-upkeep' > /etc/cron.d/flux-e2e-upkeep
chmod 0644 /etc/cron.d/flux-e2e-drop-caches /etc/cron.d/flux-e2e-upkeep
echo "harness host setup done"
