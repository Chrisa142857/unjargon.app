#!/bin/sh
# unjargon.app collector installer — user-level, no root, no dependencies.
#
#   curl -fsSL https://unjargon.app/install.sh | sh -s -- --token uj_xxx
#
# Flags:
#   --token TOK     device token from the web app (required)
#   --server URL    unjargon web app (default https://unjargon.app)
#   --binary PATH   use a locally built unjargond instead of downloading
#   --no-service    install binary + config only, don't register a service
set -eu

TOKEN=""
SERVER="https://unjargon.app"
BINARY=""
SERVICE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --token)   TOKEN="$2"; shift 2 ;;
    --server)  SERVER="$2"; shift 2 ;;
    --binary)  BINARY="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

[ -n "$TOKEN" ] || { echo "error: --token is required (get one from $SERVER/devices)" >&2; exit 2; }

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

# --- binary ------------------------------------------------------------------
if [ -n "$BINARY" ]; then
  # tmp+rename so reinstalling over a *running* unjargond doesn't hit ETXTBSY
  cp "$BINARY" "$BIN.tmp" && mv "$BIN.tmp" "$BIN"
else
  URL="${UNJARGOND_BASE_URL:-$SERVER/dl}/unjargond-$OS-$ARCH"
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
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now unjargond.service
  echo "registered systemd --user service unjargond"
else
  # HPC login node without a systemd user session.
  start_fallback
fi

echo
echo "unjargon collector installed. Start (or continue) a Claude Code session"
echo "on this machine, then open $SERVER/live — subtitles should appear."
