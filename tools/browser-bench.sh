#!/bin/bash
# Compare browsers showing the dashboard: whole-system CPU, the browser's own CPU and memory (PSS),
# whether the VA-API driver is loaded, and video frames dropped (from the page's /api/stats).
# Run on the dashboard machine inside the graphical session's environment (WAYLAND_DISPLAY set).
# Usage: [ONLY="firefox chromium chromium-vaapi"] browser-bench.sh [warmup_s] [measure_s]
# Results are appended to /tmp/browser-bench.txt
set -u
WARM=${1:-45}; DUR=${2:-120}
URL=http://localhost:8001/
OUT=/tmp/browser-bench.txt
FFPROF=$HOME/.local/share/dashboard/firefox
CRPROF=/tmp/bench-chromium
CR_COMMON=(--app=$URL --user-data-dir=$CRPROF --ozone-platform=wayland --start-maximized --no-first-run --noerrdialogs
           --disable-session-crashed-bubble --autoplay-policy=no-user-gesture-required --password-store=basic)
CR_VAAPI=--enable-features=AcceleratedVideoDecodeLinuxGL,AcceleratedVideoDecodeLinuxZeroCopyGL,VaapiVideoDecoder

pids() { pgrep -f "^$1" | tr '\n' ' '; }
ticks() { local t=0; for p in $(pids "$1"); do [ -r /proc/$p/stat ] && t=$((t + $(awk '{print $14+$15}' /proc/$p/stat))); done; echo $t; }
pss() { local k=0; for p in $(pids "$1"); do v=$(awk '/^Pss:/{print $2}' /proc/$p/smaps_rollup 2>/dev/null); k=$((k + ${v:-0})); done; echo $((k / 1024)); }
vaapi() { for p in $(pids "$1"); do grep -q i965_drv_video /proc/$p/maps 2>/dev/null && { echo yes; return; }; done; echo no; }
sys() { awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat; }
frames() { curl -s ${URL%/}/api/stats | python3 -c 'import json,sys
d=json.load(sys.stdin).get("video",{}); print(d.get("total_frames") or 0, d.get("dropped_frames") or 0, d.get("height") or 0)'; }

ONLY=${ONLY:-firefox chromium chromium-vaapi}
run() {  # name, exe-prefix, command...
    local name=$1 exe=$2; shift 2
    [[ " $ONLY " == *" $name "* ]] || return 0
    "$@" >/dev/null 2>&1 &
    local launcher=$!
    sleep "$WARM"
    # The page reports every 30 s: wait for a fresh report, measure, then wait for the next one.
    read f0 d0 h0 < <(frames); read s0 i0 < <(sys); c0=$(ticks "$exe")
    sleep "$DUR"
    read f1 d1 h1 < <(frames); read s1 i1 < <(sys); c1=$(ticks "$exe")
    local hz=$(getconf CLK_TCK) ncpu=$(nproc)
    local total=$(( s1 - s0 )) idle=$(( i1 - i0 ))
    printf "%-16s system %5.1f%%  browser %5.1f%% of a core  PSS %5d MiB  vaapi %-3s  video %sp  frames %d dropped %d\n" \
        "$name" "$(echo "100*($total-$idle)/$total" | bc -l)" "$(echo "100*($c1-$c0)/$hz/$DUR" | bc -l)" \
        "$(pss "$exe")" "$(vaapi "$exe")" "$h1" $((f1 - f0)) $((d1 - d0)) | tee -a $OUT
    pkill -f "^$exe"; sleep 1; pkill -9 -f "^$exe"; kill $launcher 2>/dev/null; sleep 5
}

echo "== $(date -Is) warmup ${WARM}s measure ${DUR}s" | tee -a $OUT
read s0 i0 < <(sys); sleep 20; read s1 i1 < <(sys)
printf "%-16s system %5.1f%%\n" idle "$(echo "100*(($s1-$s0)-($i1-$i0))/($s1-$s0)" | bc -l)" | tee -a $OUT
run firefox /usr/lib/firefox/firefox firefox --no-remote --name dashboard --class dashboard --profile "$FFPROF" $URL
crprof() {  # fresh profile using the system titlebar, which the labwc rule then removes
    rm -rf $CRPROF; mkdir -p $CRPROF/Default
    echo '{"browser":{"custom_chrome_frame":false}}' > $CRPROF/Default/Preferences
}
[[ $ONLY == *chromium* ]] && crprof; run chromium /usr/lib/chromium/chromium chromium "${CR_COMMON[@]}"
[[ $ONLY == *chromium* ]] && crprof; run chromium-vaapi /usr/lib/chromium/chromium chromium "${CR_COMMON[@]}" $CR_VAAPI
