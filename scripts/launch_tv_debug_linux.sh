#!/usr/bin/env bash
# Launch TradingView with CDP remote debugging enabled on port 9222

PORT=9222

# --- WSL2: launch TradingView from Windows via PowerShell ---
if grep -qi microsoft /proc/version 2>/dev/null; then
  echo "WSL2 detected — launching TradingView via Windows PowerShell..."

  TV_PATH=$(powershell.exe -NoProfile -Command "
    \$pkg = Get-AppxPackage -Name 'TradingView*' 2>\$null | Select-Object -First 1;
    if (\$pkg) {
      \$loc = \$pkg.InstallLocation;
      Get-ChildItem \$loc -Recurse -Filter 'TradingView.exe' 2>\$null | Select-Object -First 1 -ExpandProperty FullName
    }
  " 2>/dev/null | tr -d '\r')

  if [ -z "$TV_PATH" ]; then
    echo "ERROR: Could not find TradingView.exe via Get-AppxPackage."
    echo "Make sure TradingView Desktop is installed from the Microsoft Store."
    exit 1
  fi

  echo "Found: $TV_PATH"
  echo "Killing any running TradingView instances..."
  powershell.exe -NoProfile -Command "Stop-Process -Name TradingView -Force -ErrorAction SilentlyContinue" 2>/dev/null
  sleep 1

  echo "Launching with --remote-debugging-port=$PORT ..."
  powershell.exe -NoProfile -Command "Start-Process '$TV_PATH' -ArgumentList '--remote-debugging-port=$PORT'"

  # Ensure portproxy is set up so WSL2 can reach Windows localhost:9222
  WIN_HOST=$(ip route show | grep default | awk '{print $3}')
  PROXY_OK=$(powershell.exe -NoProfile -Command "
    netsh interface portproxy show v4tov4 | Select-String '$PORT'
  " 2>/dev/null | tr -d '\r')
  if [ -z "$PROXY_OK" ]; then
    echo "Setting up portproxy (requires admin)..."
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    WIN_SCRIPT=$(wslpath -w "$SCRIPT_DIR/setup_wsl_portproxy.ps1")
    powershell.exe -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy RemoteSigned -File \"$WIN_SCRIPT\"'"
    echo "Approve the UAC prompt, then wait a few seconds and run tv_health_check."
  else
    echo "Portproxy active on $WIN_HOST:$PORT → 127.0.0.1:$PORT"
    echo "Done. Wait a few seconds then run tv_health_check."
  fi
  exit 0
fi

# --- Native Linux ---
if command -v flatpak &>/dev/null && flatpak list 2>/dev/null | grep -q "com.tradingview.TradingViewDesktop"; then
  echo "Flatpak TradingView found. Launching..."
  pkill -f "TradingViewDesktop" 2>/dev/null; sleep 1
  flatpak run com.tradingview.TradingViewDesktop --remote-debugging-port=$PORT &
  echo "Launched. Wait a few seconds then run tv_health_check."
  exit 0
fi

if command -v tradingview &>/dev/null; then
  echo "Snap TradingView found. Launching..."
  pkill -f tradingview 2>/dev/null; sleep 1
  tradingview --remote-debugging-port=$PORT &
  echo "Launched. Wait a few seconds then run tv_health_check."
  exit 0
fi

APPIMAGE=$(ls ~/TradingView*.AppImage 2>/dev/null | head -1)
if [ -n "$APPIMAGE" ]; then
  echo "AppImage found: $APPIMAGE. Launching..."
  pkill -f "TradingView" 2>/dev/null; sleep 1
  "$APPIMAGE" --remote-debugging-port=$PORT &
  echo "Launched. Wait a few seconds then run tv_health_check."
  exit 0
fi

echo "ERROR: No TradingView installation found."
echo "Install via: flatpak install flathub com.tradingview.TradingViewDesktop"
echo "         or: sudo snap install tradingview"
exit 1
