#!/bin/zsh
# Capture why Leaf stopped responding.
#
# The symptom is always the same: the window keeps its last frame and nothing
# reacts. That frame alone says nothing about the cause -- the UI thread can be
# stuck in a filesystem call, the web process can be spinning in a loop, or
# nothing can be busy at all because the event never arrives. This collects what
# tells those apart.
#
# The web process has to be included, and it is easy to miss: WebKit's XPC
# services are launched by launchd, so `pgrep -P <leaf pid>` finds none of them
# and the app process looks idle while the page is stuck. The 0.3.58 pass
# sampled only the app process for exactly that reason, so it could not have
# seen a hung page. They are picked up here by launch time instead: a web
# process serving Leaf starts at or after Leaf does.
#
#   scripts/watch-freeze.sh now
#       One snapshot, immediately. Run this while the window is stuck.
#   scripts/watch-freeze.sh
#       Watch until stopped. Logs CPU every second for the app and its web
#       processes, and snapshots all of them as soon as one stays above 60% for
#       three seconds.
#
# Output goes to ~/leaf-freeze-<time>/: cpu.log plus sample-<process>-<time>.txt.
# `sample` needs no special permission for processes you own.
set -u
out=${LEAF_FREEZE_DIR:-$HOME/leaf-freeze-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$out"

leaf_pid() { pgrep -x leaf | head -1; }

# Unix time a process started, or nothing when it is already gone.
started_at() { date -j -f "%a %b %d %T %Y" "$(ps -o lstart= -p "$1" 2>/dev/null)" +%s 2>/dev/null; }

# The app plus every WebKit helper that came up with it.
watched_pids() {
  local pid=$(leaf_pid) since p
  [[ -n "$pid" ]] || return 1
  print -r -- "$pid"
  since=$(started_at "$pid") || return 0
  for p in $(pgrep -f 'com\.apple\.WebKit\.(WebContent|Networking|GPU)' 2>/dev/null); do
    [[ "$p" == "$pid" ]] && continue
    local start=$(started_at "$p") || continue
    (( start >= since )) && print -r -- "$p"
  done
}

snapshot() {
  local stamp=$(date +%H%M%S) pid name
  watched_pids > /dev/null || { print "Leaf is not running"; return 1; }
  for pid in $(watched_pids); do
    name=$(basename "$(ps -o comm= -p "$pid")")
    sample "$pid" 3 -mayDie -file "$out/sample-$name-$pid-$stamp.txt" >/dev/null 2>&1
    print "$(date +%H:%M:%S) sampled $name ($pid) cpu=$(ps -o %cpu= -p "$pid" | tr -d ' ')"
  done | tee -a "$out/cpu.log"
}

if [[ "${1:-}" == "now" ]]; then
  print "snapshot in $out"
  snapshot
  exit 0
fi

print "watching; output in $out"
hot=0
while true; do
  if ! watched_pids > /dev/null; then
    print "$(date +%H:%M:%S) leaf not running" >> "$out/cpu.log"
    sleep 2; continue
  fi
  local_line="" top=0 pid cpu name
  for pid in $(watched_pids); do
    cpu=$(ps -o %cpu= -p "$pid" | tr -d ' ')
    name=$(basename "$(ps -o comm= -p "$pid")")
    local_line="$local_line $name=${cpu:-0}"
    (( ${cpu%%.*} > top )) && top=${cpu%%.*}
  done
  print "$(date +%H:%M:%S)$local_line" >> "$out/cpu.log"
  (( top > 60 )) && hot=$((hot+1)) || hot=0
  if (( hot == 3 )); then
    print "$(date +%H:%M:%S) something is spinning" >> "$out/cpu.log"
    snapshot
    hot=0
    sleep 5
  fi
  sleep 1
done
