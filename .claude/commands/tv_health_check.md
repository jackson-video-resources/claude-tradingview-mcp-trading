Check whether TradingView is reachable via Chrome DevTools Protocol (CDP) on port 9222.

In WSL2, Windows processes bind to 127.0.0.1 which is not directly reachable from WSL. Use the Windows host gateway IP instead.

Run:
```bash
WIN_HOST=$(ip route show | grep default | awk '{print $3}')
if grep -qi microsoft /proc/version 2>/dev/null; then
  RESPONSE=$(curl -s --connect-timeout 5 http://$WIN_HOST:9222/json/version 2>/dev/null)
else
  RESPONSE=$(curl -s --connect-timeout 5 http://localhost:9222/json/version 2>/dev/null)
fi
if [ -n "$RESPONSE" ]; then
  echo "cdp_connected: true"
  echo "$RESPONSE"
else
  echo "cdp_connected: false"
  echo "TradingView is not reachable on port 9222."
  echo "Run: ./scripts/launch_tv_debug_linux.sh"
fi
```

Report the result clearly as either `cdp_connected: true` or `cdp_connected: false`.
