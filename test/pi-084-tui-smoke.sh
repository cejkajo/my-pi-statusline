#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
PI_BIN=${PI_BIN:-pi}
TMP=$(mktemp -d "$ROOT/.tmp-pi-084-tui.XXXXXX")
SOCKET_PREFIX="$ROOT/.s$$"

cleanup() {
  for socket in "$SOCKET_PREFIX"*; do
    [[ -e "$socket" ]] || continue
    tmux -S "$socket" kill-server 2>/dev/null || true
    rm -f "$socket"
  done
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

if ! command -v "$PI_BIN" >/dev/null 2>&1; then
  echo "pi executable not found: $PI_BIN" >&2
  exit 1
fi
if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for the Pi TUI smoke test" >&2
  exit 1
fi

version=$($PI_BIN --version)
if [[ "$version" != "0.84.0" ]]; then
  echo "expected Pi 0.84.0, got $version" >&2
  exit 1
fi

cat > "$TMP/status-provider.ts" <<'TS'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function statusProvider(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("gondolin", "vm");
    ctx.ui.setStatus("usage-limits", "5h 82% · wk 64%");
    ctx.ui.setStatus("vim-mode", "NORMAL");
    ctx.ui.setStatus("vim-pending", "g");
  });

  pi.registerCommand("e2e-status", {
    description: "Update smoke-test statuses",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("usage-limits", "5h 81% · wk 63%");
      ctx.ui.setStatus("vim-pending", "dd");
    },
  });
}
TS

assert_screen_width() {
  local capture=$1
  local width=$2
  python3 - "$capture" "$width" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
width = int(sys.argv[2])
for number, line in enumerate(path.read_text().splitlines(), 1):
    if len(line) > width:
        raise SystemExit(f"{path}:{number}: rendered {len(line)} columns at width {width}: {line!r}")
PY
}

wait_for_start() {
  local socket=$1
  local exit_file=$2
  for _ in {1..50}; do
    if [[ -f "$exit_file" ]]; then
      echo "Pi exited during startup with code $(cat "$exit_file")" >&2
      return 1
    fi
    if tmux -S "$socket" has-session -t pi 2>/dev/null \
      && tmux -S "$socket" capture-pane -p -t pi:0.0 2>/dev/null | grep -F "5h 82% · wk 64%" >/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  echo "Pi TUI did not become ready" >&2
  return 1
}

wait_for_exit() {
  local exit_file=$1
  for _ in {1..50}; do
    [[ -f "$exit_file" ]] && return 0
    sleep 0.1
  done
  echo "Pi did not exit cleanly" >&2
  return 1
}

run_mode() {
  local mode=$1
  local work="$TMP/$mode"
  local home="$work/home"
  local socket="$SOCKET_PREFIX-${mode:0:1}"
  local exit_file="$work/exit-code"
  mkdir -p "$home/.pi/agent"

  cat > "$home/.pi/agent/settings.json" <<'JSON'
{
  "quietStartup": true,
  "defaultProjectTrust": "always",
  "powerline": {
    "fixedEditor": true,
    "mouseScroll": true,
    "customItems": {
      "usage-limits": {
        "statusKey": "usage-limits",
        "position": "right"
      }
    }
  }
}
JSON

  local command
  printf -v command \
    'cd %q; env HOME=%q PI_CODING_AGENT_DIR=%q PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 POWERLINE_NERD_FONTS=0 %q --offline --no-session --no-extensions -e %q -e %q --tui-mode %q 2>%q; code=$?; printf "%%s\\n" "$code" >%q; sleep 30' \
    "$ROOT" "$home" "$home/.pi/agent" "$PI_BIN" "$ROOT" "$TMP/status-provider.ts" "$mode" "$work/stderr.log" "$exit_file"

  tmux -S "$socket" new-session -d -x 100 -y 30 -s pi "$command"
  if ! wait_for_start "$socket" "$exit_file"; then
    cat "$work/stderr.log" >&2 || true
    return 1
  fi

  tmux -S "$socket" capture-pane -p -t pi:0.0 -S - > "$work/start.txt"
  grep -F "5h 82% · wk 64%" "$work/start.txt" >/dev/null
  grep -F "NORMAL" "$work/start.txt" >/dev/null

  tmux -S "$socket" send-keys -t pi:0.0 -l "editor smoke $mode"
  sleep 0.3
  tmux -S "$socket" capture-pane -p -t pi:0.0 -S - > "$work/editor.txt"
  grep -F "editor smoke $mode" "$work/editor.txt" >/dev/null

  tmux -S "$socket" send-keys -t pi:0.0 C-c
  tmux -S "$socket" send-keys -t pi:0.0 -l "/e2e-status"
  tmux -S "$socket" send-keys -t pi:0.0 Enter
  sleep 0.4
  tmux -S "$socket" capture-pane -p -t pi:0.0 -S - > "$work/updated.txt"
  grep -F "5h 81% · wk 63%" "$work/updated.txt" >/dev/null
  grep -F "dd" "$work/updated.txt" >/dev/null

  tmux -S "$socket" resize-window -t pi:0 -x 20 -y 12
  sleep 0.4
  tmux -S "$socket" capture-pane -p -t pi:0.0 -S - > "$work/narrow.txt"
  grep -F "5h 81% · wk 63%" "$work/narrow.txt" >/dev/null
  assert_screen_width "$work/narrow.txt" 20

  tmux -S "$socket" resize-window -t pi:0 -x 120 -y 35
  sleep 0.4
  tmux -S "$socket" capture-pane -p -t pi:0.0 -S - > "$work/wide.txt"
  grep -F "5h 81% · wk 63%" "$work/wide.txt" >/dev/null
  grep -F "NORMAL" "$work/wide.txt" >/dev/null
  assert_screen_width "$work/wide.txt" 120

  tmux -S "$socket" send-keys -t pi:0.0 C-c
  tmux -S "$socket" send-keys -t pi:0.0 C-d
  wait_for_exit "$exit_file"
  [[ $(cat "$exit_file") == 0 ]]
  if grep -E "uncaughtException|RangeError|Maximum call stack|powerline-footer.*failed" "$work/stderr.log"; then
    echo "Pi reported a TUI failure in $mode mode" >&2
    return 1
  fi
}

run_mode fullscreen
run_mode regular

echo "Pi 0.84.0 TUI smoke test passed in fullscreen and regular modes"
