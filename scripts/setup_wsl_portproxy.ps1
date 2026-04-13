# Run once as Administrator to allow WSL2 to reach TradingView's CDP port.
# Right-click this file → "Run with PowerShell" (as Administrator)

$PORT = 9222

# Find the WSL2 host IP (the gateway the WSL distro uses to reach Windows)
$wslIP = (wsl -- ip route show | Select-String 'default' | ForEach-Object { ($_ -split '\s+')[2] }) | Select-Object -First 1
if (-not $wslIP) {
    Write-Error "Could not detect WSL2 IP. Is WSL running?"
    exit 1
}
Write-Host "WSL2 host gateway IP: $wslIP"

# Remove any existing portproxy rule on this port
netsh interface portproxy delete v4tov4 listenport=$PORT listenaddress=$wslIP 2>$null

# Forward <wslHostIP>:9222 → 127.0.0.1:9222 so WSL can reach Windows CDP
netsh interface portproxy add v4tov4 `
    listenport=$PORT listenaddress=$wslIP `
    connectport=$PORT connectaddress=127.0.0.1
Write-Host "portproxy rule added."

# Add firewall rule to allow inbound on port 9222 from WSL
netsh advfirewall firewall delete rule name="TradingView CDP WSL" 2>$null
netsh advfirewall firewall add rule `
    name="TradingView CDP WSL" `
    dir=in action=allow protocol=TCP `
    localport=$PORT
Write-Host "Firewall rule added."

Write-Host ""
Write-Host "Done. You can now run tv_health_check from WSL."
