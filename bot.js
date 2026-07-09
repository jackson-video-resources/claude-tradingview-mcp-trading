/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";

// ─── Telegram Alerts ─────────────────────────────────────────────────────────

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" }),
    });
  } catch (err) {
    console.log(`⚠️  Telegram alert failed: ${err.message}`);
  }
}

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your BitGet credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // OKX interval mapping (primary — no geo-blocking)
  const okxIntervalMap = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1H": "1H", "4H": "4H", "1D": "1D", "1W": "1W",
  };
  // Binance fallback mapping
  const binanceIntervalMap = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w",
  };

  // Convert BTCUSDT → BTC-USDT for OKX
  const okxSymbol = symbol.replace("USDT", "-USDT");

  // Try OKX first
  try {
    const okxInterval = okxIntervalMap[interval] || "1H";
    const url = `https://www.okx.com/api/v5/market/candles?instId=${okxSymbol}&bar=${okxInterval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OKX API error: ${res.status}`);
    const json = await res.json();
    if (json.code !== "0") throw new Error(`OKX error: ${json.msg}`);
    // OKX returns newest-first — reverse to get chronological order
    return json.data.reverse().map((k) => ({
      time: parseInt(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  } catch (okxErr) {
    // Fallback to Binance
    const binanceInterval = binanceIntervalMap[interval] || "1m";
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
    const data = await res.json();
    return data.map((k) => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }
}

// ─── Improvement 1: Claude Regime Filter ─────────────────────────────────────

async function checkMarketRegime(symbol, price, rsi3, ema8, vwap) {
  if (!process.env.ANTHROPIC_API_KEY) return { approved: true, reason: "No API key — skipping regime check" };
  const client = new Anthropic();
  const prompt = `You are a risk filter for an automated crypto trading bot. Assess whether current market conditions are safe to trade.

Symbol: ${symbol}
Current price: $${price}
RSI(3): ${rsi3.toFixed(2)}
EMA(8): $${ema8.toFixed(2)}
VWAP: $${vwap.toFixed(2)}
Time (UTC): ${new Date().toUTCString()}

Answer in JSON only: { "approved": true/false, "reason": "one sentence" }

Approve unless there is a specific high-risk condition: major scheduled macro event in the next 2 hours (Fed, CPI, NFP), extreme fear/greed divergence, or obvious black swan news. When in doubt, approve.`;

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content[0].text.trim();
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
    return json;
  } catch (err) {
    return { approved: true, reason: `Regime check error (${err.message}) — defaulting to approve` };
  }
}

// ─── Improvement 2: Volume Confirmation ──────────────────────────────────────

function checkVolume(candles) {
  const volumes = candles.slice(-21, -1).map((c) => c.volume);
  const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const currentVol = candles[candles.length - 1].volume;
  const ratio = currentVol / avgVol;
  return { pass: ratio >= 0.45, currentVol, avgVol, ratio };
}

// ─── Improvement 3: Multi-Timeframe Confirmation ──────────────────────────────

async function checkHigherTimeframe(symbol) {
  try {
    const candles1h = await fetchCandles(symbol, "1H", 20);
    const closes1h = candles1h.map((c) => c.close);
    const price1h = closes1h[closes1h.length - 1];
    const ema8_1h = calcEMA(closes1h, 8);
    const vwap1h = calcVWAP(candles1h);
    if (!vwap1h) return { pass: true, reason: "No 1H VWAP data — skipping MTF check" };
    const bullish1h = price1h > ema8_1h && price1h > vwap1h;
    const bearish1h = price1h < ema8_1h && price1h < vwap1h;
    return { pass: bullish1h || bearish1h, bullish1h, bearish1h, price1h, ema8_1h, vwap1h };
  } catch {
    return { pass: true, reason: "MTF fetch failed — skipping" };
  }
}

// ─── Improvement 4: Time Filter (skip 01:00–05:59 UTC, unless RSI > 80) ───────

function checkTradingHours(rsi3 = null) {
  const hourUTC = new Date().getUTCHours();
  const inLowLiqWindow = hourUTC >= 1 && hourUTC < 6;
  if (!inLowLiqWindow) return { pass: true, override: false, hourUTC };
  // Exception: strong RSI signal (>80 short or <20 long) overrides the window
  const strongSignal = rsi3 !== null && (rsi3 > 80 || rsi3 < 20);
  return { pass: strongSignal, override: strongSignal, hourUTC, rsi3 };
}

// ─── Improvement 5: ATR Position Sizing ──────────────────────────────────────

function calcATR(candles, period = 14) {
  const trs = candles.slice(-period - 1).map((c, i, arr) => {
    if (i === 0) return c.high - c.low;
    const prevClose = arr[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function calcATRPositionSize(price, atr, portfolioValue, maxTradeSize) {
  const riskPerTrade = portfolioValue * 0.01;
  const atrMultiplier = 1.5;
  const stopDistance = atr * atrMultiplier;
  const atrBasedSize = riskPerTrade / (stopDistance / price) * price;
  return Math.min(atrBasedSize, maxTradeSize);
}

// ─── Improvement 6: Correlation Filter ───────────────────────────────────────

function checkCorrelation(symbol, executedSymbols) {
  // Group highly correlated assets — only one per group per run
  const groups = [
    ["BTCUSDT", "ETHUSDT"],           // BTC/ETH — tightly correlated
    ["SOLUSDT", "SUIUSDT", "AVAXUSDT"], // L1 alts — moderately correlated
  ];
  for (const group of groups) {
    if (group.includes(symbol)) {
      const alreadyTraded = executedSymbols.find((s) => group.includes(s));
      if (alreadyTraded) {
        return { pass: false, reason: `Already traded correlated asset ${alreadyTraded} this run` };
      }
    }
  }
  return { pass: true };
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  let sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) sessionCandles = candles.slice(-6); // fallback: last 24H of 4H candles
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine bias first
  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    // 1. Price above VWAP
    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );

    // 2. Price above EMA(8)
    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );

    // 3. RSI(3) pullback
    check(
      "RSI(3) below 30 (snap-back setup in uptrend)",
      "< 30",
      rsi3.toFixed(2),
      rsi3 < 30,
    );

    // 4. Not overextended from VWAP
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );

    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );

    check(
      "RSI(3) above 70 (reversal setup in downtrend)",
      "> 70",
      rsi3.toFixed(2),
      rsi3 > 70,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trend-Following Check ───────────────────────────────────────────────────
// Fires when EMA(8) and EMA(21) are aligned with price + RSI in momentum zone.
// Captures sustained directional moves that snap-back misses (RSI stuck at 0/100).

function runTrendCheck(price, ema8, ema21, vwap, rsi3) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Trend Mode Check ─────────────────────────────────────\n");

  const bullishTrend = price > vwap && price > ema8 && ema8 > ema21;
  const bearishTrend = price < vwap && price < ema8 && ema8 < ema21;

  if (bullishTrend) {
    console.log("  Trend: BULLISH — EMA(8) > EMA(21), checking momentum long\n");
    check("Price above VWAP (buyers in control)", `> ${vwap.toFixed(2)}`, price.toFixed(2), price > vwap);
    check("Price above EMA(8) (uptrend confirmed)", `> ${ema8.toFixed(2)}`, price.toFixed(2), price > ema8);
    check("EMA(8) above EMA(21) (trend confirmed)", `> ${ema21.toFixed(2)}`, ema8.toFixed(2), ema8 > ema21);
    check("RSI(3) in momentum zone 40–65 (not overbought)", "40–65", rsi3.toFixed(2), rsi3 >= 40 && rsi3 <= 65);
    const dist = Math.abs((price - vwap) / vwap) * 100;
    check("Price within 1.5% of VWAP (not overextended)", "< 1.5%", `${dist.toFixed(2)}%`, dist < 1.5);
  } else if (bearishTrend) {
    console.log("  Trend: BEARISH — EMA(8) < EMA(21), checking momentum short\n");
    check("Price below VWAP (sellers in control)", `< ${vwap.toFixed(2)}`, price.toFixed(2), price < vwap);
    check("Price below EMA(8) (downtrend confirmed)", `< ${ema8.toFixed(2)}`, price.toFixed(2), price < ema8);
    check("EMA(8) below EMA(21) (trend confirmed)", `< ${ema21.toFixed(2)}`, ema8.toFixed(2), ema8 < ema21);
    check("RSI(3) in momentum zone 35–60 (not oversold)", "35–60", rsi3.toFixed(2), rsi3 >= 35 && rsi3 <= 60);
    const dist = Math.abs((price - vwap) / vwap) * 100;
    check("Price within 1.5% of VWAP (not overextended)", "< 1.5%", `${dist.toFixed(2)}%`, dist < 1.5);
  } else {
    console.log("  Trend: NEUTRAL — EMAs not aligned with price structure. No trend entry.\n");
    results.push({ label: "Trend alignment", required: "EMA(8)/EMA(21)/price aligned", actual: "Not aligned", pass: false });
  }

  const allPass = results.every((r) => r.pass);
  const direction = bullishTrend ? "LONG" : bearishTrend ? "SHORT" : null;
  return { results, allPass, direction };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── Coinbase Advanced Execution ─────────────────────────────────────────────

function buildCoinbaseJWT(method, path) {
  const keyName = CONFIG.bitget.apiKey; // organizations/.../apiKeys/...
  const privateKeyPem = CONFIG.bitget.secretKey.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "ES256",
    kid: keyName,
    nonce: crypto.randomBytes(16).toString("hex"),
  };
  const payload = {
    sub: keyName,
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    aud: ["retail_rest_api_proxy"],
    uri: `${method} api.coinbase.com${path}`,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;

  const sign = crypto.createSign("SHA256");
  sign.update(signingInput);
  sign.end();
  const sigBuf = sign.sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${sigBuf.toString("base64url")}`;
}

async function coinbaseGet(path) {
  const jwt = buildCoinbaseJWT("GET", path);
  const res = await fetch(`https://api.coinbase.com${path}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new Error(`Coinbase GET ${path} — HTTP ${res.status}`);
  return res.json();
}

async function placeCoinbaseOrder(symbol, side, sizeUSD) {
  const productId = symbol.replace("USDT", "-USDC"); // SOLUSDT → SOL-USDC
  const path = "/api/v3/brokerage/orders";
  const jwt = buildCoinbaseJWT("POST", path);

  const body = JSON.stringify({
    client_order_id: crypto.randomUUID(),
    product_id: productId,
    side: side.toUpperCase(),
    order_configuration: {
      market_market_ioc: {
        quote_size: sizeUSD.toFixed(2), // spend $X on market buy
      },
    },
  });

  const res = await fetch(`https://api.coinbase.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body,
  });

  const data = await res.json();
  if (!data.success) {
    const msg =
      data.error_response?.message || data.error || JSON.stringify(data);
    throw new Error(`Coinbase order failed: ${msg}`);
  }

  return {
    orderId: data.success_response?.order_id || "unknown",
    ...data.success_response,
  };
}

// ─── Portfolio Exposure Check ─────────────────────────────────────────────────
// Blocks trades that would add to already oversized or over-concentrated positions.
// Uses the accounts API (works reliably) rather than portfolio breakdown (restricted).
//
// Check 1 — Absolute holding value: skip if current holdings worth > $80 USDC.
//   Catches: SOL (~$139), AVAX (~$97) — both flagged in the portfolio review.
//
// Check 2 — Concentration vs USDC: skip if holding > 50% of available USDC.
//   Secondary guardrail: prevents doubling down when cash is already low.

const EXPOSURE_MAX_HOLDING_USD  = 80;  // block if holding already worth > $80
const EXPOSURE_MAX_VS_USDC_PCT  = 50;  // block if holding > 50% of USDC balance

async function runPortfolioExposureCheck(symbol, price) {
  const baseCurrency = symbol.replace("USDT", ""); // SOLUSDT → SOL

  console.log(`\n── Portfolio Exposure Check ──────────────────────────────\n`);
  console.log(`  Checking ${baseCurrency} holdings on Coinbase...`);

  try {
    const data = await coinbaseGet("/api/v3/brokerage/accounts");
    const accounts = data.accounts || [];

    const usdcAcct  = accounts.find((a) => a.currency === "USDC");
    const assetAcct = accounts.find((a) => a.currency === baseCurrency);

    const usdcBalance  = parseFloat(usdcAcct?.available_balance?.value  || 0);
    const assetBalance = parseFloat(assetAcct?.available_balance?.value || 0);
    const holdingValue = assetBalance * price; // current value in USDC terms

    if (assetBalance === 0) {
      console.log(`  ✅ No existing ${baseCurrency} holdings — clear to trade`);
      return { pass: true, reason: "No existing position" };
    }

    const vsUsdcPct = usdcBalance > 0 ? (holdingValue / usdcBalance) * 100 : 0;

    const results = [
      {
        label: `${baseCurrency} holding value`,
        required: `< $${EXPOSURE_MAX_HOLDING_USD} USDC`,
        actual: `$${holdingValue.toFixed(2)} (${assetBalance.toFixed(4)} ${baseCurrency})`,
        pass: holdingValue < EXPOSURE_MAX_HOLDING_USD,
      },
      {
        label: `Concentration vs USDC balance`,
        required: `< ${EXPOSURE_MAX_VS_USDC_PCT}% of $${usdcBalance.toFixed(2)} USDC`,
        actual: `${vsUsdcPct.toFixed(1)}%`,
        pass: vsUsdcPct < EXPOSURE_MAX_VS_USDC_PCT,
      },
    ];

    results.forEach((r) => {
      console.log(`  ${r.pass ? "✅" : "🚫"} ${r.label}`);
      console.log(`     Required: ${r.required} | Actual: ${r.actual}`);
    });

    const allPass = results.every((r) => r.pass);
    return { pass: allPass, results, holdingValue, usdcBalance, assetBalance };

  } catch (err) {
    console.log(`  ⚠️  Portfolio check error: ${err.message} — proceeding`);
    return { pass: true, reason: `Check skipped: ${err.message}` };
  }
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "Coinbase Advanced",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  const watchlist = rules.watchlist || [CONFIG.symbol];
  const executedThisRun = [];

  for (const symbol of watchlist) {
    console.log(`\n${"═".repeat(59)}`);
    console.log(`  Symbol: ${symbol} | Timeframe: ${CONFIG.timeframe}`);
    console.log(`${"═".repeat(59)}`);

    // Fetch candle data
    console.log("\n── Fetching market data (OKX → Binance fallback) ───────\n");
    const candles = await fetchCandles(symbol, CONFIG.timeframe, 500);
    const closes = candles.map((c) => c.close);
    const price = closes[closes.length - 1];
    console.log(`  Current price: $${price.toFixed(2)}`);

    // Calculate indicators
    const ema8 = calcEMA(closes, 8);
    const ema21 = calcEMA(closes, 21);
    const vwap = calcVWAP(candles);
    const rsi3 = calcRSI(closes, 3);
    const atr = calcATR(candles);

    console.log(`  EMA(8):  $${ema8.toFixed(4)}`);
    console.log(`  EMA(21): $${ema21.toFixed(4)} ${ema8 > ema21 ? "↑ bullish" : "↓ bearish"}`);
    console.log(`  VWAP:    $${vwap ? vwap.toFixed(4) : "N/A"}`);
    console.log(`  RSI(3):  ${rsi3 !== null ? rsi3.toFixed(2) : "N/A"}`);
    console.log(`  ATR(14): $${atr.toFixed(4)}`);

    if (vwap === null || rsi3 === null) {
      console.log("\n⚠️  Not enough data to calculate indicators. Skipping.");
      continue;
    }

    // ── Improvement 4: Time Filter (RSI-aware) ────────────────────────────
    console.log("\n── Time Filter ──────────────────────────────────────────\n");
    const timeCheck = checkTradingHours(rsi3);
    if (!timeCheck.pass) {
      console.log(`🚫 Low-liquidity window — ${timeCheck.hourUTC}:00 UTC (01:00–05:59 blocked).`);
      console.log(`   RSI(3) ${rsi3.toFixed(2)} — not strong enough to override (needs >80 or <20).`);
      continue;
    }
    if (timeCheck.override) {
      console.log(`⚡ Low-liquidity window overridden — RSI(3) ${rsi3.toFixed(2)} is a strong signal (>80 or <20).`);
    } else {
      console.log(`✅ Trading hours OK — ${timeCheck.hourUTC}:00 UTC`);
    }

    // ── Improvement 2: Volume Confirmation ───────────────────────────────
    console.log("\n── Volume Check ─────────────────────────────────────────\n");
    const volCheck = checkVolume(candles);
    if (!volCheck.pass) {
      console.log(`🚫 Volume too low — current: ${volCheck.currentVol.toFixed(2)}, avg: ${volCheck.avgVol.toFixed(2)} (${(volCheck.ratio * 100).toFixed(0)}% of avg)`);
      console.log("   Skipping — thin market increases slippage risk.");
      continue;
    }
    console.log(`✅ Volume OK — ${(volCheck.ratio * 100).toFixed(0)}% of 20-candle average`);

    // ── Improvement 3: Multi-Timeframe Confirmation ───────────────────────
    console.log("\n── Multi-Timeframe Check (1H) ───────────────────────────\n");
    const mtf = await checkHigherTimeframe(symbol);
    if (!mtf.pass) {
      console.log(`🚫 1H bias is NEUTRAL — no clear direction on higher timeframe. Skipping.`);
      continue;
    }
    const mtfBias = mtf.bullish1h ? "BULLISH" : "BEARISH";
    const bias4h = price > vwap && price > ema8 ? "BULLISH" : price < vwap && price < ema8 ? "BEARISH" : "NEUTRAL";
    if (mtfBias !== bias4h) {
      console.log(`🚫 1H bias (${mtfBias}) conflicts with 4H bias (${bias4h}) — no aligned setup. Skipping.`);
      continue;
    }
    console.log(`✅ 1H bias: ${mtfBias} — aligned with 4H bias`);

    // ── Improvement 6: Correlation Filter ────────────────────────────────
    console.log("\n── Correlation Filter ───────────────────────────────────\n");
    const corrCheck = checkCorrelation(symbol, executedThisRun);
    if (!corrCheck.pass) {
      console.log(`🚫 ${corrCheck.reason}`);
      continue;
    }
    console.log(`✅ No correlated asset already traded this run`);

    // ── Snap-back check (primary entry mode) ─────────────────────────────
    const snapBack = runSafetyCheck(price, ema8, vwap, rsi3, rules);
    let finalAllPass = snapBack.allPass;
    let entryMode = "SNAP-BACK";
    let tradeDirection = (price > vwap && price > ema8) ? "LONG" : "SHORT";

    // ── Trend-following check (fallback if snap-back fails) ───────────────
    if (!snapBack.allPass) {
      const trend = runTrendCheck(price, ema8, ema21, vwap, rsi3);
      if (trend.allPass) {
        finalAllPass = true;
        entryMode = "TREND";
        tradeDirection = trend.direction;
      }
    }

    // ── Improvement 5: ATR Position Sizing ───────────────────────────────
    const tradeSize = calcATRPositionSize(price, atr, CONFIG.portfolioValue, CONFIG.maxTradeSizeUSD);
    console.log(`\n── Position Size (ATR-based) ─────────────────────────────\n`);
    console.log(`  ATR(14): $${atr.toFixed(4)} | Risk 1% = $${(CONFIG.portfolioValue * 0.01).toFixed(2)}`);
    console.log(`  Calculated size: $${tradeSize.toFixed(2)} (capped at $${CONFIG.maxTradeSizeUSD})`);

    // Decision
    console.log("\n── Decision ─────────────────────────────────────────────\n");

    const logEntry = {
      timestamp: new Date().toISOString(),
      symbol,
      timeframe: CONFIG.timeframe,
      price,
      indicators: { ema8, ema21, vwap, rsi3 },
      conditions: snapBack.results,
      allPass: finalAllPass,
      entryMode,
      tradeDirection,
      tradeSize,
      orderPlaced: false,
      orderId: null,
      paperTrading: CONFIG.paperTrading,
      limits: {
        maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
        maxTradesPerDay: CONFIG.maxTradesPerDay,
        tradesToday: countTodaysTrades(log),
      },
    };

    if (!finalAllPass) {
      const failed = snapBack.results.filter((r) => !r.pass).map((r) => r.label);
      console.log(`🚫 TRADE BLOCKED`);
      console.log(`   Failed conditions:`);
      failed.forEach((f) => console.log(`   - ${f}`));
    } else {
      // ── Improvement 1: Claude Regime Filter ────────────────────────────
      console.log(`\n── Claude Regime Filter ─────────────────────────────────\n`);
      console.log(`  Checking macro environment...`);
      const regime = await checkMarketRegime(symbol, price, rsi3, ema8, vwap);
      logEntry.regimeCheck = regime;
      if (!regime.approved) {
        console.log(`🚫 REGIME BLOCKED — ${regime.reason}`);
        await sendTelegram(`⚠️ *REGIME BLOCK — ${symbol}*\n${regime.reason}`);
        continue;
      }
      console.log(`✅ Regime approved — ${regime.reason}`);

      // ── Portfolio Exposure Check ────────────────────────────────────────
      // Only runs for BUY signals — skip for TREND SHORT (no order placed anyway)
      if (!(tradeDirection === "SHORT" && entryMode === "TREND")) {
        const exposure = await runPortfolioExposureCheck(symbol, price);
        logEntry.exposureCheck = exposure;
        if (!exposure.pass) {
          const blocked = (exposure.results || [])
            .filter((r) => !r.pass)
            .map((r) => r.label)
            .join(", ");
          console.log(`\n🚫 EXPOSURE BLOCKED — ${blocked}`);
          const baseCurrency = symbol.replace("USDT", "");
          await sendTelegram(
            `⚠️ *EXPOSURE BLOCK — ${symbol}*\n` +
            `${baseCurrency} holding: $${exposure.holdingValue?.toFixed(2)} (limit $${EXPOSURE_MAX_HOLDING_USD})\n` +
            `USDC balance: $${exposure.usdcBalance?.toFixed(2)}\n` +
            `Not adding to an oversized position.`
          );
          continue;
        }
      }

      console.log(`\n✅ ALL CONDITIONS MET — Entry mode: ${entryMode} | Direction: ${tradeDirection}`);

      // Spot exchange: can only BUY. TREND SHORT = signal logged, no order.
      if (tradeDirection === "SHORT" && entryMode === "TREND") {
        console.log(`\n⚠️  TREND SHORT signal on spot exchange — logging signal, no order placed.`);
        console.log(`   (Spot trading cannot short — signal recorded for reference)`);
        logEntry.orderId = `TREND-SHORT-SIGNAL-${Date.now()}`;
        await sendTelegram(
          `📉 *TREND SHORT SIGNAL — ${symbol}*\n` +
          `Price: $${price.toFixed(4)} | RSI(3): ${rsi3.toFixed(2)}\n` +
          `EMA8: $${ema8.toFixed(4)} < EMA21: $${ema21.toFixed(4)}\n` +
          `⚠️ Spot only — no order placed. Monitor for reversal.`
        );
      } else if (CONFIG.paperTrading) {
        const side = tradeDirection === "SHORT" ? "SELL" : "BUY";
        console.log(`\n📋 PAPER TRADE — would ${side} ${symbol} ~$${tradeSize.toFixed(2)} at market`);
        console.log(`   Mode: ${entryMode} | (Set PAPER_TRADING=false in .env to place real orders)`);
        logEntry.orderPlaced = true;
        logEntry.orderId = `PAPER-${Date.now()}`;
        executedThisRun.push(symbol);
        await sendTelegram(
          `📋 *PAPER TRADE — ${symbol}*\n` +
          `Mode: ${entryMode} | Side: ${side} | Size: $${tradeSize.toFixed(2)} | Price: $${price.toFixed(4)}\n` +
          `RSI(3): ${rsi3.toFixed(2)} | EMA8: $${ema8.toFixed(4)} | EMA21: $${ema21.toFixed(4)} | VWAP: $${vwap.toFixed(4)}\n` +
          `ATR size: $${tradeSize.toFixed(2)} | 1H bias: ${mtfBias}\n` +
          `Regime: ${regime.reason}\n` +
          `_Paper mode — no real order placed_`
        );
      } else {
        console.log(`\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} BUY ${symbol} [${entryMode}]`);
        try {
          const order = await placeCoinbaseOrder(symbol, "buy", tradeSize);
          logEntry.orderPlaced = true;
          logEntry.orderId = order.orderId;
          executedThisRun.push(symbol);
          console.log(`✅ ORDER PLACED — ${order.orderId}`);
          await sendTelegram(
            `✅ *LIVE TRADE EXECUTED — ${symbol}*\n` +
            `Mode: ${entryMode} | Side: BUY | Size: $${tradeSize.toFixed(2)} | Price: $${price.toFixed(4)}\n` +
            `Order ID: ${order.orderId}\n` +
            `RSI(3): ${rsi3.toFixed(2)} | EMA8/21: $${ema8.toFixed(2)}/$${ema21.toFixed(2)} | 1H: ${mtfBias}\n` +
            `Regime: ${regime.reason}`
          );
        } catch (err) {
          console.log(`❌ ORDER FAILED — ${err.message}`);
          logEntry.error = err.message;
          await sendTelegram(`❌ *ORDER FAILED — ${symbol}*\nError: ${err.message}`);
        }
      }
    }

    // Save decision log
    log.trades.push(logEntry);
    saveLog(log);
    console.log(`\nDecision log saved → ${LOG_FILE}`);

    // Write tax CSV row for every run (executed, paper, or blocked)
    writeTradeCsv(logEntry);
  }

  console.log("\n" + "═".repeat(59) + "\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
