#!/bin/sh
# unjargon.app collector installer — user-level, no root, no dependencies.
#
#   curl -fsSL https://raw.githubusercontent.com/Chrisa142857/unjargon.app/main/install.sh \
#     | sh -s -- --server https://unjargon.onrender.com
#
# Flags:
#   --pair CODE     pairing code from the web app (prompts when omitted)
#   --server URL    unjargon web app (default https://unjargon.onrender.com)
#   --binary PATH   use a locally built unjargond instead of downloading
#   --no-service    install binary + config only, don't register a service
#   --reimport      intentionally re-send existing transcript history once
#   --uninstall      remove this machine's collector, queue, and service
set -eu

PAIR_CODE=""
SERVER="https://unjargon.onrender.com"
BINARY=""
SERVICE=1
REIMPORT=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --pair)    PAIR_CODE="$2"; shift 2 ;;
    --server)  SERVER="$2"; shift 2 ;;
    --binary)  BINARY="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    --reimport) REIMPORT=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [ "$UNINSTALL" -eq 1 ]; then
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  BIN_DIR="$HOME/.local/bin"
  BIN="$BIN_DIR/unjargond"
  CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/unjargond"
  STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/unjargond"
  if [ "$OS" = darwin ]; then
    PLIST="$HOME/Library/LaunchAgents/app.unjargon.unjargond.plist"
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
  elif command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now unjargond.service 2>/dev/null || true
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/unjargond.service"
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  if [ -r "$STATE_DIR/unjargond.pid" ]; then
    kill "$(cat "$STATE_DIR/unjargond.pid")" 2>/dev/null || true
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PYEOF'
import json, os
path = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "settings.json")
try:
    with open(path) as f: cfg = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    cfg = None
if cfg:
    root = cfg.get("hooks")
    if isinstance(root, dict):
        hooks = root.get("SessionStart", [])
        root["SessionStart"] = [e for e in hooks if not any("unjargond" in h.get("command", "") for h in e.get("hooks", []))]
        with open(path, "w") as f: json.dump(cfg, f, indent=2); f.write("\n")
PYEOF
  fi
  rm -f "$BIN" "$CONF_DIR/env"
  rm -rf "$STATE_DIR"
  rmdir "$CONF_DIR" 2>/dev/null || true
  echo "uninstalled unjargond from this machine (local queue and logs removed; Claude/Codex transcripts untouched)"
  exit 0
fi

if [ -z "$PAIR_CODE" ]; then
  if [ -r /dev/tty ]; then
    printf "Pairing code (from unjargon in your browser): " > /dev/tty
    IFS= read -r PAIR_CODE < /dev/tty
  else
    echo "error: --pair is required when no interactive terminal is available" >&2
    exit 2
  fi
fi
[ -n "$PAIR_CODE" ] || { echo "error: pairing code cannot be empty" >&2; exit 2; }
DEVICE=$(hostname | tr -cd 'A-Za-z0-9._-')
TOKEN=$(curl -fsS -X POST --data-urlencode "code=$PAIR_CODE" --data-urlencode "device=$DEVICE" "$SERVER/api/devices/claim") || { echo "error: could not claim this device" >&2; exit 1; }
# Services start with a minimal environment; include common user CLI bins plus
# the safe system locations instead of relying on an interactive shell PATH.
CLI_PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.volta/bin:$HOME/.asdf/shims:$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.local/share/pnpm:$HOME/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Applications/ChatGPT.app/Contents/Resources:$HOME/Applications/ChatGPT.app/Contents/Resources"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
case "$OS" in
  darwin|linux) ;;
  *) echo "unsupported OS: $OS (macOS and Linux only)" >&2; exit 1 ;;
esac

BIN_DIR="$HOME/.local/bin"
BIN="$BIN_DIR/unjargond"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/unjargond"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/unjargond"
mkdir -p "$BIN_DIR" "$CONF_DIR" "$STATE_DIR"

if [ "$REIMPORT" -eq 1 ]; then
  # Explicit only: offsets prevent duplicate history on normal reinstalls.
  rm -f "$STATE_DIR/offsets.json" "$STATE_DIR/backfill-v1.done"
  echo "cleared local transcript offsets; existing history will be re-imported once"
fi

# --- binary ------------------------------------------------------------------
if [ -n "$BINARY" ]; then
  # tmp+rename so reinstalling over a *running* unjargond doesn't hit ETXTBSY
  cp "$BINARY" "$BIN.tmp" && mv "$BIN.tmp" "$BIN"
else
  URL="${UNJARGOND_BASE_URL:-https://github.com/Chrisa142857/unjargon.app/releases/latest/download}/unjargond-$OS-$ARCH"
  echo "downloading $URL"
  if ! curl -fsSL -o "$BIN.tmp" "$URL"; then
    echo "download failed. Build from source instead:" >&2
    echo "  git clone https://github.com/Chrisa142857/unjargon.app && cd unjargon.app/collector" >&2
    echo "  go build -o $BIN ./cmd/unjargond" >&2
    echo "then re-run this installer with --binary $BIN" >&2
    exit 1
  fi
  mv "$BIN.tmp" "$BIN"
fi
chmod +x "$BIN"
echo "installed $BIN"

# --- config ------------------------------------------------------------------
umask 077
cat > "$CONF_DIR/env" <<EOF
UNJARGON_SERVER=$SERVER
UNJARGON_TOKEN=$TOKEN
UNJARGON_DEVICE=$DEVICE
UNJARGON_BACKFILL=all
UNJARGON_LOCAL_EXPLAIN=auto
EOF
echo "wrote $CONF_DIR/env"

# --- Claude Code SessionStart hook (primary transcript discovery) -------------
if command -v python3 >/dev/null 2>&1; then
  python3 - "$BIN hook" <<'PYEOF'
import json, os, sys
cmd = sys.argv[1]
conf_dir = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
path = os.path.join(conf_dir, "settings.json")
try:
    with open(path) as f:
        cfg = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    cfg = {}
entries = cfg.setdefault("hooks", {}).setdefault("SessionStart", [])
already = any(
    "unjargond" in h.get("command", "")
    for e in entries
    for h in e.get("hooks", [])
)
if already:
    print("Claude Code hook already registered")
else:
    entries.append({"hooks": [{"type": "command", "command": cmd}]})
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    print(f"registered SessionStart hook in {path}")
PYEOF
else
  echo "python3 not found — register the hook manually in ~/.claude/settings.json:"
  echo '  {"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"'"$BIN"' hook"}]}]}}'
fi

# --- service -----------------------------------------------------------------
start_fallback() {
  # Plain background process + PID file (the daemon no-ops if already running).
  nohup "$BIN" run >> "$STATE_DIR/unjargond.log" 2>&1 &
  echo "started unjargond in the background (log: $STATE_DIR/unjargond.log)"
  echo "add this to your ~/.bashrc so it survives logouts on this host:"
  echo "  $BIN run >> $STATE_DIR/unjargond.log 2>&1 &"
}

if [ "$SERVICE" -eq 0 ]; then
  echo "skipping service registration (--no-service); start manually: $BIN run"
elif [ "$OS" = darwin ]; then
  PLIST="$HOME/Library/LaunchAgents/app.unjargon.unjargond.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.unjargon.unjargond</string>
  <key>ProgramArguments</key><array><string>$BIN</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$CLI_PATH</string>
  </dict>
  <key>StandardOutPath</key><string>$STATE_DIR/unjargond.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/unjargond.log</string>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "registered LaunchAgent app.unjargon.unjargond"
elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/unjargond.service" <<EOF
[Unit]
Description=unjargon collector (tails agent transcripts)
After=network-online.target

[Service]
ExecStart=$BIN run
Environment="PATH=$CLI_PATH"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable unjargond.service
  systemctl --user restart unjargond.service
  echo "registered systemd --user service unjargond"
else
  # HPC login node without a systemd user session.
  start_fallback
fi

echo
echo "unjargon collector installed. Start (or continue) a Claude Code session"
echo "on this machine, then open $SERVER/live — detected jargon should appear."
echo "Existing Claude Code and Codex sessions are imported once on this install."
echo
echo "AI usage notice: importing, detecting, and public term references use zero AI calls."
echo "AI is used only after you choose 'explain in my sessions' and confirm it,"
echo "capped at 30 calls of at most 30 seconds per rolling 5 hours. To disable"
echo "local on-demand explanations entirely:"
echo "  echo 'UNJARGON_LOCAL_EXPLAIN=off' >> $CONF_DIR/env"
