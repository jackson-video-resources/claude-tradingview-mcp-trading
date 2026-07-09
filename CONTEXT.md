# Trading Bot — Session Context

> Read this file at the start of any new Claude session to get full context.
> Last updated: 2026-04-29

---

## What This Is

An automated crypto trading bot built during a single onboarding session. It runs on Railway (cloud), checks 8 symbols every 30 minutes, uses a 7-layer filter stack before placing any order, and sends Telegram alerts on every trade execution.

**Repository:** `~/Documents/claude-tradingview-mcp-trading`
**Railway project:** `trading-bot` (service ID: `55277c91-4a51-4d3f-86e0-007162489784`)
**Railway URL:** https://railway.com/project/faf02701-24bb-40f8-b0ac-fa377821a000

---

## Exchange

**Coinbase Advanced** (`advanced.coinbase.com`)
- API credentials stored in `.env` (never display these)
- No passphrase — Coinbase uses EC private keys
- Trade mode: `spot`

---

## Portfolio Settings

| Setting | Value |
|---|---|
| Portfolio size | $1,000 |
| Max trade size | $50 per trade |
| Max trades/day | 20 |
| Paper trading | **OFF** — bot is LIVE |

> ⚠️ Bot is in LIVE mode. Real orders will be placed when all conditions are met.
> To switch back to paper: `railway variables set PAPER_TRADING=true --service trading-bot`

---

## Watchlist (8 symbols)

```
BTCUSDT, ETHUSDT, RNDRUSDT, SOLUSDT, SUIUSDT, ADAUSDT, AVAXUSDT, DOGEUSDT
```

Added in this order:
- BTC, ETH — original
- RNDR (Render Network) — replaced FET (too illiquid) and NEAR (insufficient data)
- SOL, SUI, ADA, AVAX — added 2026-04-28
- DOGE — added 2026-04-28 (IMX and ILV rejected — too illiquid)

---

## Strategy

**Name:** VWAP + RSI(3) + EMA(8) Scalping Strategy — Enhanced
**Timeframe:** 4H candles
**Data source:** Binance public API (free, no auth)

### Seven-Layer Filter Stack (in order)

| # | Filter | Rule |
|---|---|---|
| 1 | Trade limits | Max 20 trades/day, max $50/trade |
| 2 | Time filter | Block 01:00–05:59 UTC — **exception: RSI(3) >80 or <20 overrides** |
| 3 | Volume confirmation | Current candle must be ≥60% of 20-candle average |
| 4 | Multi-timeframe (1H) | 1H bias must be bullish or bearish (not neutral) |
| 5 | Correlation filter | No BTC+ETH same run / No SOL+SUI+AVAX same run |
| 6 | Safety check | VWAP + EMA(8) + RSI(3) conditions (see below) |
| 7 | Claude regime filter | claude-haiku checks macro environment before every trade |

### Entry Conditions

**Long:** Price above VWAP + Price above EMA(8) + RSI(3) < 30
**Short:** Price below VWAP + Price below EMA(8) + RSI(3) > 70

### Position Sizing
ATR(14)-based: `min(portfolio * 0.01 / (ATR * 1.5 / price) * price, $50)`

---

## Alerts

**Telegram bot token and chat ID** stored in `.env`
Alerts fire on: paper trade, live trade execution, regime block, order failure
Test: send any message via `sendTelegram()` function in bot.js

---

## Schedule

**Railway cron:** `*/30 * * * *` — runs every 30 minutes
Changed from hourly to 30-min on 2026-04-29 to catch RSI spikes faster

---

## Key Files

| File | Purpose |
|---|---|
| `bot.js` | Main bot — all logic, filters, execution |
| `rules.json` | Strategy document — watchlist, filters, entry rules |
| `.env` | All credentials and config (never commit) |
| `railway.json` | Railway deployment config + cron schedule |
| `trades.csv` | Full trade log — every run recorded (tax records) |
| `safety-check-log.json` | Full audit trail of every decision |
| `CONTEXT.md` | This file |

---

## Trade History

As of 2026-04-29, **no trades have executed** — all runs blocked by filters.

**Primary blockers observed:**
- Volume consistently below threshold (post-spike averages inflate the 20-candle avg)
- RSI(3) spikes occur at candle open when volume is too low to pass
- 1H bias neutral on RNDR throughout

**Notable near-misses:**
- 2026-04-28 00:07 UTC — BTC RSI hit 100, ETH RSI hit 100. Volume only 4–5% (new candle, 7 min old). Time filter overridden by RSI exception but volume blocked.
- 2026-04-29 01:00 UTC — BTC RSI 100 again, SOL RSI 80. Same volume issue at candle open.

**Volume threshold** was lowered from 80% → 60% on 2026-04-27 to handle post-breakout consolidation periods.

---

## Performance Tracking (New Session Goal)

The next session should track:
1. First live trade execution — symbol, price, size, outcome
2. Win/loss rate as trades accumulate
3. P&L vs portfolio value over time
4. Which filter is blocking most frequently (from `safety-check-log.json`)
5. Whether any strategy adjustments are needed based on real results

### Quick commands for a new session

```bash
# Check current market and run bot
cd ~/Documents/claude-tradingview-mcp-trading && node bot.js

# View trade history
cat trades.csv

# Tax summary
node bot.js --tax-summary

# Deploy changes
railway up --service trading-bot

# Switch to paper trading
railway variables set PAPER_TRADING=true --service trading-bot

# Switch to live trading
railway variables set PAPER_TRADING=false --service trading-bot
```

---

## GitHub

**Fork:** https://github.com/antwan81/claude-tradingview-mcp-trading
**Upstream PR:** https://github.com/jackson-video-resources/claude-tradingview-mcp-trading/pull/6

To push updates:
```bash
git add <files> && git commit -m "message" && git push fork main
```

---

## What Was Built This Session (Summary)

1. Cloned Lewis Jackson's trading bot repo
2. Connected Coinbase Advanced API
3. Set portfolio guardrails ($1,000 / $50 / 20 trades)
4. Chose demo strategy (VWAP + RSI3 + EMA8)
5. Deployed to Railway with hourly schedule
6. Added Telegram alerts
7. Went LIVE (PAPER_TRADING=false)
8. Added 6 improvements: Claude regime filter, volume confirmation, MTF check, time filter, ATR sizing, correlation filter
9. Updated rules.json to document full strategy
10. Expanded watchlist to 8 symbols (added SOL, SUI, ADA, AVAX, DOGE — rejected IMX, ILV, FET, NEAR)
11. Fixed volume threshold 80%→60%
12. Added RSI exception to time filter (>80 or <20 overrides low-liquidity block)
13. Changed schedule from hourly to 30-minute
14. Opened PR #6 to upstream repo
