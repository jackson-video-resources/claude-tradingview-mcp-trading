/**
 * Claude + TradingView MCP — Automated Trading Bot
 * Multi-strategy, multi-asset edition
 *
 * Runs all 14 strategies across all configured assets on every tick.
 * Set STRATEGY= in .env to choose which strategy executes orders.
 * Set SYMBOLS= to a comma-separated list of assets to trade.
 *
 * Strategies:
 *   vwap_scalp         VWAP + RSI(3) + EMA(8)        — scalping
 *   ema_cross          EMA(9/21) crossover            — trend following
 *   bb_rsi             Bollinger Bands + RSI(14)      — mean reversion
 *   macd               MACD crossover (12/26/9)       — momentum
 *   stoch_rsi          Stochastic RSI                 — overbought/oversold
 *   supertrend         Supertrend (ATR-based)         — trend direction
 *   ichimoku           Ichimoku Cloud                 — multi-component trend
 *   rsi_divergence     RSI Divergence                 — reversal signal
 *   adx                ADX Trend Strength             — trend filter
 *   ema_3              3-EMA System                   — triple alignment
 *   heikin_ashi        Heikin Ashi Trend              — smoothed candles
 *   orb                Opening Range Breakout         — session breakout
 *   support_resistance Support / Resistance           — key level bounces
 *   volume_profile     Volume Profile                 — high-volume price areas
 *
 * Local:  node bot.js
 * Cloud:  deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import sql from "mssql";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log("\n⚠️  No .env file found — opening it for you to fill in...\n");
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
        "",
        "# Strategy to execute: vwap_scalp | ema_cross | bb_rsi | macd",
        "# All 4 strategies are evaluated and logged to trades.csv every run.",
        "# This controls which one actually places orders.",
        "STRATEGY=vwap_scalp",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log("Fill in your BitGet credentials in .env then re-run: node bot.js\n");
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

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbols: (process.env.SYMBOLS || process.env.SYMBOL || "BTCUSDT")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  strategy: process.env.STRATEGY || "vwap_scalp",
  exchange: (process.env.EXCHANGE || "bitget").toLowerCase(),
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
  coinbase: {
    apiKey: process.env.BITGET_API_KEY,       // reuses same env vars
    secretKey: process.env.BITGET_SECRET_KEY, // reuses same env vars
    baseUrl: "https://api.coinbase.com",
  },
  azureSQL: {
    server:   process.env.AZURE_SQL_SERVER,
    database: process.env.AZURE_SQL_DATABASE,
    user:     process.env.AZURE_SQL_USER,
    password: process.env.AZURE_SQL_PASSWORD,
    enabled:  !!(process.env.AZURE_SQL_SERVER && process.env.AZURE_SQL_DATABASE),
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Config Validation ───────────────────────────────────────────────────────

function validateConfig() {
  const errors = [];

  if (!Number.isFinite(CONFIG.portfolioValue) || CONFIG.portfolioValue <= 0)
    errors.push("PORTFOLIO_VALUE_USD must be a positive number");

  if (!Number.isFinite(CONFIG.maxTradeSizeUSD) || CONFIG.maxTradeSizeUSD <= 0)
    errors.push("MAX_TRADE_SIZE_USD must be a positive number");

  if (!Number.isInteger(CONFIG.maxTradesPerDay) || CONFIG.maxTradesPerDay <= 0)
    errors.push("MAX_TRADES_PER_DAY must be a positive integer");

  if (CONFIG.maxTradeSizeUSD > CONFIG.portfolioValue * 0.5)
    errors.push("MAX_TRADE_SIZE_USD cannot exceed 50% of PORTFOLIO_VALUE_USD");

  const validTimeframes = ["1m","3m","5m","15m","30m","1H","4H","1D","1W"];
  if (!validTimeframes.includes(CONFIG.timeframe))
    errors.push(`TIMEFRAME must be one of: ${validTimeframes.join(", ")}`);

  if (CONFIG.symbols.length === 0)
    errors.push("SYMBOLS must contain at least one trading pair (e.g. BTCUSDT)");
  for (const sym of CONFIG.symbols) {
    if (!/^[A-Z0-9]{3,20}$/.test(sym))
      errors.push(`Invalid symbol: ${sym} — must be uppercase alphanumeric (e.g. BTCUSDT)`);
  }

  if (!["bitget","coinbase"].includes(CONFIG.exchange))
    errors.push("EXCHANGE must be 'bitget' or 'coinbase'");

  const bitgetBaseUrl = CONFIG.bitget.baseUrl;
  if (!bitgetBaseUrl.startsWith("https://"))
    errors.push("BITGET_BASE_URL must use HTTPS");

  if (errors.length > 0) {
    console.error("\n❌ Configuration errors:");
    errors.forEach((e) => console.error(`   - ${e}`));
    process.exit(1);
  }
}

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log, strategyKey, symbol) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) =>
      t.timestamp.startsWith(today) &&
      t.orderPlaced &&
      t.strategy === strategyKey &&
      t.symbol === symbol,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 200) {
  const intervalMap = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w",
  };
  const binanceInterval = intervalMap[interval];
  if (!binanceInterval) throw new Error(`Invalid interval: ${interval}`);

  const safeSymbol = encodeURIComponent(symbol.replace(/[^A-Z0-9]/g, ""));
  const url = `https://api.binance.com/api/v3/klines?symbol=${safeSymbol}&interval=${binanceInterval}&limit=${limit}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);

  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("Binance API returned unexpected response type");

  return data.map((k, idx) => {
    if (!Array.isArray(k) || k.length < 6)
      throw new Error(`Binance candle ${idx} has invalid structure`);

    const time   = parseInt(k[0]);
    const open   = parseFloat(k[1]);
    const high   = parseFloat(k[2]);
    const low    = parseFloat(k[3]);
    const close  = parseFloat(k[4]);
    const volume = parseFloat(k[5]);

    if (![time, open, high, low, close, volume].every(Number.isFinite))
      throw new Error(`Binance candle ${idx} contains non-finite values`);

    if (high < low || high < open || high < close || low > open || low > close)
      throw new Error(`Binance candle ${idx} has invalid OHLC: H=${high} L=${low} O=${open} C=${close}`);

    return { time, open, high, low, close, volume };
  });
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

// Single EMA value at the last close
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

// Full EMA series — one value per candle from index (period-1) onward
function calcEMASeries(closes, period) {
  if (closes.length < period) return [];
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const series = [ema];
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
    series.push(ema);
  }
  return series;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const session = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (session.length === 0) return null;
  const cumTPV = session.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const cumVol = session.reduce((s, c) => s + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// Bollinger Bands — 20-period SMA ± 2 standard deviations
function calcBollingerBands(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, c) => s + Math.pow(c - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return { upper: sma + mult * stdDev, middle: sma, lower: sma - mult * stdDev };
}

// MACD(12, 26, 9) — returns current and previous cross values for crossover detection
function calcMACD(closes) {
  const ema12Series = calcEMASeries(closes, 12);
  const ema26Series = calcEMASeries(closes, 26);
  if (ema12Series.length < 2 || ema26Series.length < 2) return null;

  // ema26 starts at close[25], ema12 starts at close[11] — align with offset=14
  const offset = 26 - 12;
  const macdLine = ema26Series.map((e26, i) => ema12Series[i + offset] - e26);
  if (macdLine.length < 2) return null;

  const signalSeries = calcEMASeries(macdLine, 9);
  if (signalSeries.length < 2) return null;

  return {
    macd: macdLine[macdLine.length - 1],
    signal: signalSeries[signalSeries.length - 1],
    histogram: macdLine[macdLine.length - 1] - signalSeries[signalSeries.length - 1],
    prevMACD: macdLine[macdLine.length - 2],
    prevSignal: signalSeries[signalSeries.length - 2],
  };
}

// RSI as a full series — needed for StochRSI and RSI Divergence
function calcRSISeries(closes, period = 14) {
  const series = [];
  for (let i = period + 1; i <= closes.length; i++) {
    series.push(calcRSI(closes.slice(0, i), period));
  }
  return series;
}

// Stochastic RSI — RSI normalised into a 0-100 oscillator
// Returns %K (fast) and %D (3-period SMA of K)
function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3) {
  const rsiSeries = calcRSISeries(closes, rsiPeriod);
  if (rsiSeries.length < stochPeriod + kSmooth + 1) return null;

  const rawStoch = [];
  for (let i = stochPeriod - 1; i < rsiSeries.length; i++) {
    const window = rsiSeries.slice(i - stochPeriod + 1, i + 1);
    const hi = Math.max(...window), lo = Math.min(...window);
    rawStoch.push(hi === lo ? 50 : ((rsiSeries[i] - lo) / (hi - lo)) * 100);
  }
  if (rawStoch.length < kSmooth * 2) return null;

  const sma = (arr, n) => arr.slice(-n).reduce((a, b) => a + b, 0) / n;
  const k = sma(rawStoch, kSmooth);
  const prevK = sma(rawStoch.slice(0, -kSmooth), kSmooth);
  const d = (k + prevK) / 2;
  return { k, d, prevK };
}

// ATR — Wilder's smoothed Average True Range
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

// Supertrend — ATR-based dynamic support/resistance
// direction: 1 = price above line (bullish), -1 = price below line (bearish)
function calcSupertrend(candles, period = 10, multiplier = 3.0) {
  if (candles.length < period + 2) return null;

  // Build ATR series using Wilder's smoothing
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    ));
  }
  const atrSeries = [null]; // index 0 has no ATR
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period - 1; i++) atrSeries.push(null);
  atrSeries.push(atr);
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    atrSeries.push(atr);
  }

  let prevUpper = null, prevLower = null, prevSuper = null, direction = 1;

  for (let i = period; i < candles.length; i++) {
    const c = candles[i], atrVal = atrSeries[i];
    if (!atrVal) continue;
    const hl2 = (c.high + c.low) / 2;

    let upper = hl2 + multiplier * atrVal;
    let lower = hl2 - multiplier * atrVal;

    if (prevUpper !== null) upper = (upper < prevUpper || candles[i - 1].close > prevUpper) ? upper : prevUpper;
    if (prevLower !== null) lower = (lower > prevLower || candles[i - 1].close < prevLower) ? lower : prevLower;

    if (prevSuper === null) {
      direction = c.close > hl2 ? 1 : -1;
    } else if (direction === 1) {
      direction = c.close < lower ? -1 : 1;
    } else {
      direction = c.close > upper ? 1 : -1;
    }

    prevUpper = upper; prevLower = lower;
    prevSuper = direction === 1 ? lower : upper;
  }

  return { value: prevSuper, direction, upper: prevUpper, lower: prevLower };
}

// Ichimoku Cloud — five-component Japanese trend system
function calcIchimoku(candles) {
  if (candles.length < 78) return null; // need 52 + 26 for cloud projection

  const hi = (arr, n) => Math.max(...arr.slice(-n).map((c) => c.high));
  const lo = (arr, n) => Math.min(...arr.slice(-n).map((c) => c.low));

  const tenkan  = (hi(candles, 9)  + lo(candles, 9))  / 2;
  const kijun   = (hi(candles, 26) + lo(candles, 26)) / 2;
  const senkouA = (tenkan + kijun) / 2;
  const senkouB = (hi(candles, 52) + lo(candles, 52)) / 2;

  // Current cloud is Senkou from 26 periods ago
  const past = candles.slice(0, -26);
  if (past.length < 52) return null;
  const pastTenkan  = (hi(past, 9)  + lo(past, 9))  / 2;
  const pastKijun   = (hi(past, 26) + lo(past, 26)) / 2;
  const pastSpanA   = (pastTenkan + pastKijun) / 2;
  const pastSpanB   = (hi(past, 52) + lo(past, 52)) / 2;
  const cloudTop    = Math.max(pastSpanA, pastSpanB);
  const cloudBottom = Math.min(pastSpanA, pastSpanB);

  const chikou    = candles[candles.length - 1].close;
  const priceAgo  = candles[candles.length - 27]?.close ?? null;

  return { tenkan, kijun, senkouA, senkouB, cloudTop, cloudBottom, chikou, priceAgo };
}

// ADX — Average Directional Index with +DI / -DI
// ADX > 25 = trending; +DI > -DI = up, +DI < -DI = down
function calcADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;

  const plusDMs = [], minusDMs = [], trs = [];
  for (let i = 1; i < candles.length; i++) {
    const up   = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDMs.push(up > down && up > 0 ? up : 0);
    minusDMs.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    ));
  }

  // Wilder's cumulative smoothing
  const wilderSmooth = (arr) => {
    let val = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [val];
    for (let i = period; i < arr.length; i++) { val = val - val / period + arr[i]; out.push(val); }
    return out;
  };

  const sTR = wilderSmooth(trs);
  const sPDM = wilderSmooth(plusDMs);
  const sMDM = wilderSmooth(minusDMs);

  const plusDI  = (sPDM[sPDM.length - 1] / sTR[sTR.length - 1]) * 100;
  const minusDI = (sMDM[sMDM.length - 1] / sTR[sTR.length - 1]) * 100;

  const dxSeries = sPDM.map((_, i) => {
    const pdi = (sPDM[i] / sTR[i]) * 100;
    const mdi = (sMDM[i] / sTR[i]) * 100;
    const sum = pdi + mdi;
    return sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100;
  });

  let adx = dxSeries.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxSeries.length; i++) adx = (adx * (period - 1) + dxSeries[i]) / period;

  return { adx, plusDI, minusDI };
}

// Heikin Ashi — smoothed candles that filter out noise
function calcHeikinAshi(candles) {
  const ha = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen  = i === 0 ? (c.open + c.close) / 2 : (ha[i - 1].open + ha[i - 1].close) / 2;
    ha.push({
      open:  haOpen,
      high:  Math.max(c.high, haOpen, haClose),
      low:   Math.min(c.low,  haOpen, haClose),
      close: haClose,
      time:  c.time,
    });
  }
  return ha;
}

// Opening Range — first candle of the UTC trading day
function calcOpeningRange(candles) {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const todayCandles = candles.filter((c) => c.time >= todayMs);
  if (todayCandles.length < 2) return null; // need at least 2 candles — can't trade the ORB candle itself
  return { high: todayCandles[0].high, low: todayCandles[0].low, open: todayCandles[0].open };
}

// Support & Resistance — swing highs/lows over the last `lookback` candles
function calcSupportResistance(candles, lookback = 40) {
  if (candles.length < lookback + 4) return null;
  const price   = candles[candles.length - 1].close;
  const slice   = candles.slice(-lookback);
  const swingHi = [], swingLo = [];

  for (let i = 2; i < slice.length - 2; i++) {
    const h = slice[i].high;
    if (h > slice[i-1].high && h > slice[i-2].high && h > slice[i+1].high && h > slice[i+2].high) swingHi.push(h);
    const l = slice[i].low;
    if (l < slice[i-1].low  && l < slice[i-2].low  && l < slice[i+1].low  && l < slice[i+2].low)  swingLo.push(l);
  }

  const resistance = swingHi.filter((h) => h > price).sort((a, b) => a - b)[0] ?? null;
  const support    = swingLo.filter((l) => l < price).sort((a, b) => b - a)[0] ?? null;
  return { support, resistance };
}

// Volume Profile — Point of Control and Value Area over last `lookback` candles
function calcVolumeProfile(candles, lookback = 50) {
  const slice    = candles.slice(-lookback);
  const prices   = slice.map((c) => c.close);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const BUCKETS  = 20;
  const bucketSz = (maxPrice - minPrice) / BUCKETS;
  if (bucketSz === 0) return null;

  const profile = new Array(BUCKETS).fill(0);
  for (const c of slice) {
    const b = Math.min(Math.floor((c.close - minPrice) / bucketSz), BUCKETS - 1);
    profile[b] += c.volume;
  }

  const maxVol  = Math.max(...profile);
  const pocIdx  = profile.indexOf(maxVol);
  const poc     = minPrice + (pocIdx + 0.5) * bucketSz;

  // Value Area — expand from POC until 70% of volume is covered
  const totalVol = profile.reduce((a, b) => a + b, 0);
  let accVol = profile[pocIdx], lo = pocIdx, hi = pocIdx;
  while (accVol < totalVol * 0.7 && (lo > 0 || hi < BUCKETS - 1)) {
    const addLo = lo > 0           ? profile[lo - 1] : 0;
    const addHi = hi < BUCKETS - 1 ? profile[hi + 1] : 0;
    if (addLo >= addHi && lo > 0)      { accVol += addLo; lo--; }
    else if (hi < BUCKETS - 1)         { accVol += addHi; hi++; }
    else break;
  }

  return {
    poc,
    valueAreaHigh: minPrice + (hi + 1) * bucketSz,
    valueAreaLow:  minPrice + lo * bucketSz,
  };
}

// RSI Divergence — compares recent price swings vs RSI swings
// Bullish: price makes lower low but RSI makes higher low (hidden strength)
// Bearish: price makes higher high but RSI makes lower high (hidden weakness)
function calcRSIDivergence(closes, rsiSeries, lookback = 14) {
  if (closes.length < lookback * 2 || rsiSeries.length < lookback * 2) return null;

  const recentP = closes.slice(-lookback),    prevP = closes.slice(-lookback * 2, -lookback);
  const recentR = rsiSeries.slice(-lookback), prevR = rsiSeries.slice(-lookback * 2, -lookback);

  const bullish = Math.min(...recentP) < Math.min(...prevP) && Math.min(...recentR) > Math.min(...prevR);
  const bearish = Math.max(...recentP) > Math.max(...prevP) && Math.max(...recentR) < Math.max(...prevR);

  return { bullish, bearish };
}

// ─── Strategy Evaluators ─────────────────────────────────────────────────────

// Shared helper — logs and returns a condition result
function condition(label, required, actual, pass) {
  const icon = pass ? "✅" : "🚫";
  console.log(`  ${icon} ${label}`);
  console.log(`     Required: ${required} | Actual: ${actual}`);
  return { label, required, actual, pass };
}

// ── Strategy 1: VWAP + RSI(3) + EMA(8) Scalping ─────────────────────────────
// All three indicators must agree. EMA(8) for trend, VWAP for session bias,
// RSI(3) for entry timing. Very selective — few signals, high quality.
function evalVWAPScalp(price, ema8, vwap, rsi3) {
  const conditions = [];
  let signal = "none";

  const bullish = price > vwap && price > ema8;
  const bearish = price < vwap && price < ema8;

  console.log("\n── Strategy 1: VWAP + RSI(3) + EMA(8) Scalp ────────────\n");

  if (bullish) {
    console.log("  Bias: BULLISH\n");
    signal = "long";
    const dist = Math.abs((price - vwap) / vwap) * 100;
    conditions.push(condition("Price above VWAP (buyers in control)", `> ${vwap.toFixed(2)}`, price.toFixed(2), price > vwap));
    conditions.push(condition("Price above EMA(8) (uptrend confirmed)", `> ${ema8.toFixed(2)}`, price.toFixed(2), price > ema8));
    conditions.push(condition("RSI(3) below 30 (pullback in uptrend)", "< 30", rsi3.toFixed(2), rsi3 < 30));
    conditions.push(condition("Price within 1.5% of VWAP (not overextended)", "< 1.5%", `${dist.toFixed(2)}%`, dist < 1.5));
  } else if (bearish) {
    console.log("  Bias: BEARISH\n");
    signal = "short";
    const dist = Math.abs((price - vwap) / vwap) * 100;
    conditions.push(condition("Price below VWAP (sellers in control)", `< ${vwap.toFixed(2)}`, price.toFixed(2), price < vwap));
    conditions.push(condition("Price below EMA(8) (downtrend confirmed)", `< ${ema8.toFixed(2)}`, price.toFixed(2), price < ema8));
    conditions.push(condition("RSI(3) above 70 (bounce in downtrend)", "> 70", rsi3.toFixed(2), rsi3 > 70));
    conditions.push(condition("Price within 1.5% of VWAP (not overextended)", "< 1.5%", `${dist.toFixed(2)}%`, dist < 1.5));
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    conditions.push({ label: "Market bias", required: "Bullish or bearish", actual: "Neutral", pass: false });
  }

  return { key: "vwap_scalp", name: "VWAP + RSI(3) + EMA(8)", signal, conditions, allPass: conditions.every((c) => c.pass) };
}

// ── Strategy 2: EMA(9/21) Crossover ──────────────────────────────────────────
// Fires when the fast EMA(9) crosses the slow EMA(21). Classic trend-following.
// Requires a fresh cross on this candle — avoids re-entering an established trend.
function evalEMACross(price, ema9, ema21, prevEma9, prevEma21, rsi14) {
  const conditions = [];
  let signal = "none";

  const aboveEMA = ema9 > ema21;
  const freshLongCross = prevEma9 <= prevEma21 && ema9 > ema21;
  const freshShortCross = prevEma9 >= prevEma21 && ema9 < ema21;

  console.log("\n── Strategy 2: EMA(9/21) Crossover ─────────────────────\n");

  if (aboveEMA) {
    console.log(`  Bias: BULLISH (EMA9 ${ema9.toFixed(2)} > EMA21 ${ema21.toFixed(2)})\n`);
    signal = "long";
    conditions.push(condition("EMA(9) above EMA(21) (uptrend)", `> ${ema21.toFixed(2)}`, ema9.toFixed(2), aboveEMA));
    conditions.push(condition("Fresh crossover this candle", `prev EMA9 ≤ EMA21`, `${prevEma9.toFixed(2)} vs ${prevEma21.toFixed(2)}`, freshLongCross));
    conditions.push(condition("RSI(14) below 70 (not overbought)", "< 70", rsi14.toFixed(2), rsi14 < 70));
  } else {
    console.log(`  Bias: BEARISH (EMA9 ${ema9.toFixed(2)} < EMA21 ${ema21.toFixed(2)})\n`);
    signal = "short";
    conditions.push(condition("EMA(9) below EMA(21) (downtrend)", `< ${ema21.toFixed(2)}`, ema9.toFixed(2), !aboveEMA));
    conditions.push(condition("Fresh crossover this candle", `prev EMA9 ≥ EMA21`, `${prevEma9.toFixed(2)} vs ${prevEma21.toFixed(2)}`, freshShortCross));
    conditions.push(condition("RSI(14) above 30 (not oversold)", "> 30", rsi14.toFixed(2), rsi14 > 30));
  }

  return { key: "ema_cross", name: "EMA(9/21) Crossover", signal, conditions, allPass: conditions.every((c) => c.pass) };
}

// ── Strategy 3: Bollinger Bands + RSI(14) ────────────────────────────────────
// Mean reversion. Price touches the outer band = stretched too far, likely to snap back.
// RSI confirms the stretch. Works best in ranging/sideways markets.
function evalBBRSI(price, bb, rsi14) {
  const conditions = [];
  let signal = "none";

  const atLowerBand = price <= bb.lower * 1.002;  // within 0.2% of lower band
  const atUpperBand = price >= bb.upper * 0.998;
  const bandWidth = ((bb.upper - bb.lower) / bb.middle) * 100;

  console.log("\n── Strategy 3: Bollinger Bands + RSI(14) ────────────────\n");

  if (atLowerBand) {
    console.log("  Bias: BULLISH (price at lower band)\n");
    signal = "long";
    conditions.push(condition("Price at lower Bollinger Band", `≤ ${bb.lower.toFixed(2)}`, price.toFixed(2), atLowerBand));
    conditions.push(condition("RSI(14) oversold (below 35)", "< 35", rsi14.toFixed(2), rsi14 < 35));
    conditions.push(condition("Bands wide enough to trade (>1%)", "> 1%", `${bandWidth.toFixed(2)}%`, bandWidth > 1));
  } else if (atUpperBand) {
    console.log("  Bias: BEARISH (price at upper band)\n");
    signal = "short";
    conditions.push(condition("Price at upper Bollinger Band", `≥ ${bb.upper.toFixed(2)}`, price.toFixed(2), atUpperBand));
    conditions.push(condition("RSI(14) overbought (above 65)", "> 65", rsi14.toFixed(2), rsi14 > 65));
    conditions.push(condition("Bands wide enough to trade (>1%)", "> 1%", `${bandWidth.toFixed(2)}%`, bandWidth > 1));
  } else {
    console.log("  Bias: NEUTRAL — price mid-range, not at a band.\n");
    conditions.push({ label: "Price at band extreme", required: "At upper or lower band", actual: "Mid-range", pass: false });
  }

  return { key: "bb_rsi", name: "Bollinger Bands + RSI(14)", signal, conditions, allPass: conditions.every((c) => c.pass) };
}

// ── Strategy 4: MACD Crossover (12/26/9) ─────────────────────────────────────
// Momentum shift. When the MACD line crosses the signal line, momentum is changing.
// Fresh cross only — don't enter after the move has already started.
function evalMACD(macdData) {
  const conditions = [];
  let signal = "none";

  const aboveSignal = macdData.macd > macdData.signal;
  const freshBullishCross = macdData.prevMACD <= macdData.prevSignal && macdData.macd > macdData.signal;
  const freshBearishCross = macdData.prevMACD >= macdData.prevSignal && macdData.macd < macdData.signal;

  console.log("\n── Strategy 4: MACD Crossover (12/26/9) ─────────────────\n");

  if (aboveSignal) {
    console.log("  Bias: BULLISH\n");
    signal = "long";
    conditions.push(condition("MACD above signal line", `> ${macdData.signal.toFixed(4)}`, macdData.macd.toFixed(4), aboveSignal));
    conditions.push(condition("Fresh bullish crossover", "prev MACD ≤ Signal", freshBullishCross ? "YES (fresh)" : "NO (already crossed)", freshBullishCross));
  } else {
    console.log("  Bias: BEARISH\n");
    signal = "short";
    conditions.push(condition("MACD below signal line", `< ${macdData.signal.toFixed(4)}`, macdData.macd.toFixed(4), !aboveSignal));
    conditions.push(condition("Fresh bearish crossover", "prev MACD ≥ Signal", freshBearishCross ? "YES (fresh)" : "NO (already crossed)", freshBearishCross));
  }

  return { key: "macd", name: "MACD Crossover (12/26/9)", signal, conditions, allPass: conditions.every((c) => c.pass) };
}

// ── Strategy 5: Stochastic RSI ───────────────────────────────────────────────
// K < 20 crossing above D = oversold recovery (long). K > 80 crossing below D = overbought reversal (short).
function evalStochRSI(stochRSI) {
  const conditions = [];
  let signal = "none";
  const { k, d, prevK } = stochRSI;

  console.log("\n── Strategy 5: Stochastic RSI ───────────────────────────\n");

  if (k < 50) {
    console.log(`  Bias: BULLISH SETUP (K=${k.toFixed(2)} below midline)\n`);
    signal = "long";
    conditions.push(condition("StochRSI K oversold (below 20)", "< 20", k.toFixed(2), k < 20));
    conditions.push(condition("K crossing above D (momentum turning up)", `D=${d.toFixed(2)}`, `K=${k.toFixed(2)}`, k > d && prevK <= d));
    conditions.push(condition("K below 50 (not already extended)", "< 50", k.toFixed(2), k < 50));
  } else {
    console.log(`  Bias: BEARISH SETUP (K=${k.toFixed(2)} above midline)\n`);
    signal = "short";
    conditions.push(condition("StochRSI K overbought (above 80)", "> 80", k.toFixed(2), k > 80));
    conditions.push(condition("K crossing below D (momentum turning down)", `D=${d.toFixed(2)}`, `K=${k.toFixed(2)}`, k < d && prevK >= d));
    conditions.push(condition("K above 50 (not already extended)", "> 50", k.toFixed(2), k > 50));
  }

  return { key: "stoch_rsi", name: "Stochastic RSI", signal, conditions, allPass: conditions.every((c) => c.pass) };
}

// ── Strategy 6: Supertrend ────────────────────────────────────────────────────
// Price above Supertrend line = bullish. Price below = bearish. Direction change = entry.
function evalSupertrend(price, supertrend) {
  const conditions = [];
  const { value, direction } = supertrend;
  let signal = "none";

  console.log("\n── Strategy 6: Supertrend (ATR 10, mult 3.0) ────────────\n");

  if (direction === 1) {
    console.log(`  Bias: BULLISH (price above Supertrend)\n`);
    signal = "long";
    conditions.push(condition("Price above Supertrend line (uptrend)", `> ${value.toFixed(2)}`, price.toFixed(2), price > value));
    conditions.push(condition("Supertrend direction is bullish", "= 1", String(direction), direction === 1));
    const dist = ((price - value) / price) * 100;
    conditions.push(condition("Price within 3% of Supertrend (fresh signal)", "< 3%", `${dist.toFixed(2)}%`, dist < 3));
  } else {
    console.log(`  Bias: BEARISH (price below Supertrend)\n`);
    signal = "short";
    conditions.push(condition("Price below Supertrend line (downtrend)", `< ${value.toFixed(2)}`, price.toFixed(2), price < value));
    conditions.push(condition("Supertrend direction is bearish", "= -1", String(direction), direction === -1));
    const dist = ((value - price) / price) * 100;
    conditions.push(condition("Price within 3% of Supertrend (fresh signal)", "< 3%", `${dist.toFixed(2)}%`, dist < 3));
  }

  return { key: "supertrend", name: "Supertrend", signal, conditions, allPass: conditions.every((c) => c.pass) };
}

// ── Strategy 7: Ichimoku Cloud ────────────────────────────────────────────────
// Strong signal: price above/below cloud, Tenkan/Kijun aligned, Chikou confirms.
function evalIchimoku(price, ichimoku) {
  const { tenkan, kijun, cloudTop, cloudBottom, chikou, priceAgo } = ichimoku;
  const conditions = [];
  let signal = "none";

  console.log("\n── Strategy 7: Ichimoku Cloud ───────────────────────────\n");

  const aboveCloud = price > cloudTop;
  const belowCloud = price < cloudBottom;

  if (aboveCloud) {
    console.log(`  Bias: BULLISH (price above cloud)\n`);
    signal = "long";
    conditions.push(condition("Price above cloud top", `> ${cloudTop.toFixed(2)}`, price.toFixed(2), aboveCloud));
    conditions.push(condition("Tenkan above Kijun (bullish cross)", `> ${kijun.toFixed(2)}`, tenkan.toFixed(2), tenkan > kijun));
    conditions.push(condition("Chikou above price from 26 periods ago", `> ${priceAgo?.toFixed(2) ?? "N/A"}`, chikou.toFixed(2), priceAgo !== null && chikou > priceAgo));
  } else if (belowCloud) {
    console.log(`  Bias: BEARISH (price below cloud)\n`);
    signal = "short";
    conditions.push(condition("Price below cloud bottom", `< ${cloudBottom.toFixed(2)}`, price.toFixed(2), belowCloud));
    conditions.push(condition("Tenkan below Kijun (bearish cross)", `< ${kijun.toFixed(2)}`, tenkan.toFixed(2), tenkan < kijun));
    conditions.push(condition("Chikou below price from 26 periods ago", `< ${priceAgo?.toFixed(2) ?? "N/A"}`, chikou.toFixed(2), priceAgo !== null && chikou < priceAgo));
  } else {
    console.log("  Bias: NEUTRAL — price inside cloud.\n");
    conditions.push({ label: "Price outside cloud", required: "Above or below cloud", actual: "Inside cloud", pass: false });
  }

  return { key: "ichimoku", name: "Ichimoku Cloud", signal, conditions, allPass: conditions.every((c) => c.pass) };
}

// ── Strategy 8: RSI Divergence ────────────────────────────────────────────────
// Price and RSI moving in opposite directions — signals upcoming reversal.
function evalRSIDivergence(divergence, rsi14) {
  const { bullish, bearish } = divergence;
  const conditions = [];
  let signal = "none";

  console.log("\n── Strategy 8: RSI Divergence ───────────────────────────\n");

  if (bearish) {
    console.log("  Bias: BEARISH DIVERGENCE (price higher high, RSI lower high)\n");
    signal = "short";
    conditions.push(condition("Bearish divergence detected", "price HH + RSI LH", "YES", bearish));
    conditions.push(condition("RSI not deeply oversold (valid bearish)", "> 40", rsi14.toFixed(2), rsi14 > 40));
  } else if (bullish) {
    console.log("  Bias: BULLISH DIVERGENCE (price lower low, RSI higher low)\n");
    signal = "long";
    conditions.push(condition("Bullish divergence detected", "price LL + RSI HL", "YES", bullish));
    conditions.push(condition("RSI not deeply overbought (valid bullish)", "< 60", rsi14.toFixed(2), rsi14 < 60));
  } else {
    console.log("  Bias: NEUTRAL — no divergence detected.\n");
    conditions.push({ label: "Divergence detected", required: "Bullish or bearish divergence", actual: "None", pass: false });
  }

  return { key: "rsi_divergence", name: "RSI Divergence", signal, conditions, allPass: conditions.every((c) => c.pass) };
}

// ── Strategy 9: ADX Trend Strength ───────────────────────────────────────────
// Only trades when ADX > 25 (strong trend). Direction from +DI vs -DI.
function evalADX(adxData) {
  const { adx, plusDI, minusDI } = adxData;
  const conditions = [];
  let signal = "none";

  console.log("\n── Strategy 9: ADX Trend Strength ──────────────────────\n");

  if (plusDI > minusDI) {
    console.log(`  Bias: BULLISH (+DI ${plusDI.toFixed(2)} > -DI ${minusDI.toFixed(2)})\n`);
    signal = "long";
    conditions.push(condition("ADX shows strong trend (> 25)", "> 25", adx.toFixed(2), adx > 25));
    conditions.push(condition("+DI above -DI (bullish pressure)", `> ${minusDI.toFixed(2)}`, plusDI.toFixed(2), plusDI > minusDI));
    conditions.push(condition("+DI clearly dominant (> 5 spread)", "> 5 spread", (plusDI - minusDI).toFixed(2), plusDI - minusDI > 5));
  } else {
    console.log(`  Bias: BEARISH (-DI ${minusDI.toFixed(2)} > +DI ${plusDI.toFixed(2)})\n`);
    signal = "short";
    conditions.push(condition("ADX shows strong trend (> 25)", "> 25", adx.toFixed(2), adx > 25));
    conditions.push(condition("-DI above +DI (bearish pressure)", `> ${plusDI.toFixed(2)}`, minusDI.toFixed(2), minusDI > plusDI));
    conditions.push(condition("-DI clearly dominant (> 5 spread)", "> 5 spread", (minusDI - plusDI).toFixed(2), minusDI - plusDI > 5));
  }

  return { key: "adx", name: "ADX Trend Strength", signal, conditions, allPass: conditions.every((c) => c.pass) };
}

// ── Strategy 10: 3-EMA System ─────────────────────────────────────────────────
// All three EMAs stacked in order = clean trend. Entry on pullback to middle EMA.
function evalThreeEMA(price, ema8, ema21, ema50) {
  const conditions = [];
  let signal = "none";

  console.log("\n── Strategy 10: 3-EMA System (8/21/50) ─────────────────\n");

  const bullStack = ema8 > ema21 && ema21 > ema50;
  const bearStack = ema8 < ema21 && ema21 < ema50;

  if (bullStack) {
    console.log(`  Bias: BULLISH (EMA8 > EMA21 > EMA50)\n`);
    signal = "long";
    conditions.push(condition("EMA(8) > EMA(21) > EMA(50) stacked bullish", `${ema21.toFixed(2)} < ${ema8.toFixed(2)}`, `EMA50=${ema50.toFixed(2)}`, bullStack));
    const distToEma21 = ((price - ema21) / price) * 100;
    conditions.push(condition("Price near EMA(21) — pullback entry", "within 1%", `${distToEma21.toFixed(2)}%`, Math.abs(distToEma21) < 1));
    conditions.push(condition("Price above EMA(50) — in uptrend zone", `> ${ema50.toFixed(2)}`, price.toFixed(2), price > ema50));
  } else if (bearStack) {
    console.log(`  Bias: BEARISH (EMA8 < EMA21 < EMA50)\n`);
    signal = "short";
    conditions.push(condition("EMA(8) < EMA(21) < EMA(50) stacked bearish", `${ema21.toFixed(2)} > ${ema8.toFixed(2)}`, `EMA50=${ema50.toFixed(2)}`, bearStack));
    const distToEma21 = ((ema21 - price) / price) * 100;
    conditions.push(condition("Price near EMA(21) — pullback entry", "within 1%", `${distToEma21.toFixed(2)}%`, Math.abs(distToEma21) < 1));
    conditions.push(condition("Price below EMA(50) — in downtrend zone", `< ${ema50.toFixed(2)}`, price.toFixed(2), price < ema50));
  } else {
    console.log("  Bias: NEUTRAL — EMAs not stacked in order.\n");
    conditions.push({ label: "EMA stack aligned", required: "8 > 21 > 50 or 8 < 21 < 50", actual: "Mixed", pass: false });
  }

  return { key: "ema_3", name: "3-EMA System (8/21/50)", signal, conditions, allPass: conditions.every((c) => c.pass) };
}

// ── Strategy 11: Heikin Ashi Trend ────────────────────────────────────────────
// 3 consecutive bullish/bearish HA candles with no opposing wicks = strong trend.
function evalHeikinAshi(haCandles) {
  const conditions = [];
  let signal = "none";
  const last3 = haCandles.slice(-3);

  console.log("\n── Strategy 11: Heikin Ashi Trend ──────────────────────\n");

  const allBullish = last3.every((c) => c.close > c.open);
  const allBearish = last3.every((c) => c.close < c.open);
  const noLowerWick = last3.every((c) => c.low === Math.min(c.open, c.close));   // bullish: no lower wick
  const noUpperWick = last3.every((c) => c.high === Math.max(c.open, c.close));  // bearish: no upper wick

  if (allBullish) {
    console.log("  Bias: BULLISH (3 consecutive green HA candles)\n");
    signal = "long";
    conditions.push(condition("Last 3 HA candles are bullish (green)", "close > open × 3", "YES", allBullish));
    conditions.push(condition("No lower wicks (strong buyers, no pullback)", "no lower wick × 3", noLowerWick ? "YES" : "HAS WICKS", noLowerWick));
  } else if (allBearish) {
    console.log("  Bias: BEARISH (3 consecutive red HA candles)\n");
    signal = "short";
    conditions.push(condition("Last 3 HA candles are bearish (red)", "close < open × 3", "YES", allBearish));
    conditions.push(condition("No upper wicks (strong sellers, no pullback)", "no upper wick × 3", noUpperWick ? "YES" : "HAS WICKS", noUpperWick));
  } else {
    console.log("  Bias: NEUTRAL — no consistent HA trend.\n");
    conditions.push({ label: "3 consecutive HA candles", required: "All bullish or all bearish", actual: "Mixed", pass: false });
  }

  return { key: "heikin_ashi", name: "Heikin Ashi Trend", signal, conditions, allPass: conditions.every((c) => c.pass) };
}

// ── Strategy 12: Opening Range Breakout ───────────────────────────────────────
// Break above/below the first candle of the UTC session = directional signal.
function evalORB(price, orb) {
  const { high: orbHigh, low: orbLow } = orb;
  const conditions = [];
  let signal = "none";
  const orbRange = orbHigh - orbLow;

  console.log("\n── Strategy 12: Opening Range Breakout ──────────────────\n");
  console.log(`  ORB High: $${orbHigh.toFixed(2)} | ORB Low: $${orbLow.toFixed(2)}\n`);

  if (price > orbHigh) {
    signal = "long";
    const breakout = ((price - orbHigh) / orbHigh) * 100;
    conditions.push(condition("Price broke above ORB high", `> ${orbHigh.toFixed(2)}`, price.toFixed(2), price > orbHigh));
    conditions.push(condition("Breakout within 2% (not too extended)", "< 2%", `${breakout.toFixed(2)}%`, breakout < 2));
    conditions.push(condition("ORB range meaningful (> 0.3%)", "> 0.3%", `${((orbRange / orbLow) * 100).toFixed(2)}%`, orbRange / orbLow > 0.003));
  } else if (price < orbLow) {
    signal = "short";
    const breakout = ((orbLow - price) / orbLow) * 100;
    conditions.push(condition("Price broke below ORB low", `< ${orbLow.toFixed(2)}`, price.toFixed(2), price < orbLow));
    conditions.push(condition("Breakout within 2% (not too extended)", "< 2%", `${breakout.toFixed(2)}%`, breakout < 2));
    conditions.push(condition("ORB range meaningful (> 0.3%)", "> 0.3%", `${((orbRange / orbLow) * 100).toFixed(2)}%`, orbRange / orbLow > 0.003));
  } else {
    console.log("  Bias: NEUTRAL — price inside opening range.\n");
    conditions.push({ label: "ORB breakout", required: "Price above ORB high or below ORB low", actual: "Inside range", pass: false });
  }

  return { key: "orb", name: "Opening Range Breakout", signal, conditions, allPass: conditions.every((c) => c.pass) };
}

// ── Strategy 13: Support / Resistance ────────────────────────────────────────
// Price bouncing off a key level — confirmed by RSI not being at an extreme.
function evalSupportResistance(price, sr, rsi14) {
  const { support, resistance } = sr;
  const conditions = [];
  let signal = "none";

  console.log("\n── Strategy 13: Support / Resistance ───────────────────\n");
  if (support)    console.log(`  Nearest support:    $${support.toFixed(2)}`);
  if (resistance) console.log(`  Nearest resistance: $${resistance.toFixed(2)}\n`);

  const nearSupport    = support    && Math.abs((price - support)    / price) < 0.005;
  const nearResistance = resistance && Math.abs((price - resistance) / price) < 0.005;

  if (nearSupport) {
    signal = "long";
    conditions.push(condition("Price at support level (within 0.5%)", `~${support.toFixed(2)}`, price.toFixed(2), nearSupport));
    conditions.push(condition("RSI not overbought (room to bounce)", "< 60", rsi14.toFixed(2), rsi14 < 60));
    conditions.push(condition("Support level exists", "swing low found", support ? "YES" : "NO", !!support));
  } else if (nearResistance) {
    signal = "short";
    conditions.push(condition("Price at resistance level (within 0.5%)", `~${resistance.toFixed(2)}`, price.toFixed(2), nearResistance));
    conditions.push(condition("RSI not oversold (room to reject)", "> 40", rsi14.toFixed(2), rsi14 > 40));
    conditions.push(condition("Resistance level exists", "swing high found", resistance ? "YES" : "NO", !!resistance));
  } else {
    console.log("  Bias: NEUTRAL — price not at a key level.\n");
    conditions.push({ label: "Price at key level", required: "Within 0.5% of support or resistance", actual: "Mid-range", pass: false });
  }

  return { key: "support_resistance", name: "Support / Resistance", signal, conditions, allPass: conditions.every((c) => c.pass) };
}

// ── Strategy 14: Volume Profile ───────────────────────────────────────────────
// Trades toward the Point of Control (POC) from the Value Area edges.
function evalVolumeProfile(price, vp, rsi14) {
  const { poc, valueAreaHigh, valueAreaLow } = vp;
  const conditions = [];
  let signal = "none";

  console.log("\n── Strategy 14: Volume Profile ──────────────────────────\n");
  console.log(`  POC: $${poc.toFixed(2)} | VAH: $${valueAreaHigh.toFixed(2)} | VAL: $${valueAreaLow.toFixed(2)}\n`);

  const atVAL = price <= valueAreaLow  * 1.003;
  const atVAH = price >= valueAreaHigh * 0.997;
  const abovePOC = price > poc;

  if (atVAL && !abovePOC) {
    signal = "long";
    conditions.push(condition("Price at Value Area Low (buyers expected)", `≤ ${valueAreaLow.toFixed(2)}`, price.toFixed(2), atVAL));
    conditions.push(condition("RSI oversold (< 40) — confirms weakness exhausted", "< 40", rsi14.toFixed(2), rsi14 < 40));
    conditions.push(condition("POC above price — magnetic target", `> ${price.toFixed(2)}`, poc.toFixed(2), poc > price));
  } else if (atVAH && abovePOC) {
    signal = "short";
    conditions.push(condition("Price at Value Area High (sellers expected)", `≥ ${valueAreaHigh.toFixed(2)}`, price.toFixed(2), atVAH));
    conditions.push(condition("RSI overbought (> 60) — confirms strength exhausted", "> 60", rsi14.toFixed(2), rsi14 > 60));
    conditions.push(condition("POC below price — magnetic target", `< ${price.toFixed(2)}`, poc.toFixed(2), poc < price));
  } else {
    console.log("  Bias: NEUTRAL — price not at Value Area edge.\n");
    conditions.push({ label: "Price at Value Area edge", required: "At VAH or VAL", actual: "Mid-range", pass: false });
  }

  return { key: "volume_profile", name: "Volume Profile", signal, conditions, allPass: conditions.every((c) => c.pass) };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log, strategyKey, symbol) {
  const todayCount = countTodaysTrades(log, strategyKey, symbol);
  console.log(`\n── Trade Limits [${strategyKey} / ${symbol}] ──────────────────────\n`);

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }

  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);
  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`);
  console.log(`✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`);
  return true;
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet order failed: ${data.msg}`);
  return data.data;
}

// ─── Coinbase Advanced Execution ─────────────────────────────────────────────

// Coinbase Advanced uses ES256 JWT auth — signed with the EC private key
function signCoinbaseJWT(method, path) {
  const keyName = CONFIG.coinbase.apiKey;
  const privateKey = CONFIG.coinbase.secretKey.replace(/\\n/g, "\n");

  const hasPEMHeader = privateKey.includes("BEGIN EC PRIVATE KEY") || privateKey.includes("BEGIN PRIVATE KEY");
  const hasPEMFooter = privateKey.includes("END EC PRIVATE KEY") || privateKey.includes("END PRIVATE KEY");
  if (!hasPEMHeader || !hasPEMFooter)
    throw new Error("Invalid EC private key format — check BITGET_SECRET_KEY in .env");

  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: keyName,
    iss: "cdp",
    nbf: now,
    exp: now + 30,
    uri: `${method} api.coinbase.com${path}`,
  })).toString("base64url");

  const signingInput = `${header}.${payload}`;
  try {
    const sign = crypto.createSign("SHA256");
    sign.update(signingInput);
    sign.end();
    const sig = sign.sign({ key: privateKey, format: "pem", type: "pkcs8" }, "base64url");
    return `${signingInput}.${sig}`;
  } catch (err) {
    throw new Error(`JWT signing failed — check BITGET_SECRET_KEY format`);
  }
}

// Map Binance-style symbol (BTCUSDT) to Coinbase product_id (BTC-USD)
function toCoinbaseSymbol(symbol) {
  // Common mappings — extend as needed
  const map = {
    BTCUSDT: "BTC-USD", ETHUSDT: "ETH-USD", SOLUSDT: "SOL-USD",
    BNBUSDT: "BNB-USD", XRPUSDT: "XRP-USD", ADAUSDT: "ADA-USD",
    DOGEUSDT: "DOGE-USD", AVAXUSDT: "AVAX-USD", MATICUSDT: "MATIC-USD",
    LINKUSDT: "LINK-USD", DOTUSDT: "DOT-USD", LTCUSDT: "LTC-USD",
    TAOUSDT: "TAO-USD",
  };
  return map[symbol] || symbol.replace("USDT", "-USD");
}

async function placeCoinbaseOrder(symbol, side, sizeUSD, price) {
  const productId = toCoinbaseSymbol(symbol);
  const path = "/api/v3/brokerage/orders";
  const jwt = signCoinbaseJWT("POST", path);

  // Coinbase buy uses quote_size (USD), sell uses base_size (coin quantity)
  const orderConfig = side === "buy"
    ? { market_market_ioc: { quote_size: sizeUSD.toFixed(2) } }
    : { market_market_ioc: { base_size: (sizeUSD / price).toFixed(8) } };

  const body = JSON.stringify({
    client_order_id: `claude-${Date.now()}`,
    product_id: productId,
    side: side.toUpperCase(),
    order_configuration: orderConfig,
  });

  const res = await fetch(`${CONFIG.coinbase.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${jwt}`,
    },
    body,
  });

  const data = await res.json();
  if (!data.success) {
    const reason = data.error_response?.message || data.error || JSON.stringify(data);
    throw new Error(`Coinbase order failed: ${reason}`);
  }
  return { orderId: data.success_response?.order_id };
}

// ─── Order Dispatcher ─────────────────────────────────────────────────────────

async function placeOrder(symbol, side, sizeUSD, price) {
  if (CONFIG.exchange === "coinbase") {
    return placeCoinbaseOrder(symbol, side, sizeUSD, price);
  }
  return placeBitGetOrder(symbol, side, sizeUSD, price);
}

// ─── Azure SQL Logging ───────────────────────────────────────────────────────

let sqlPool = null;

async function getPool() {
  if (sqlPool) return sqlPool;
  sqlPool = await sql.connect({
    server: CONFIG.azureSQL.server,
    database: CONFIG.azureSQL.database,
    user: CONFIG.azureSQL.user,
    password: CONFIG.azureSQL.password,
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 3, min: 0, idleTimeoutMillis: 30000 },
  });
  return sqlPool;
}

async function initAzureSQL() {
  if (!CONFIG.azureSQL.enabled) return;
  try {
    const pool = await getPool();
    await pool.request().query(`
      IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_NAME = 'trades'
      )
      CREATE TABLE trades (
        id            INT IDENTITY(1,1) PRIMARY KEY,
        trade_date    DATE,
        trade_time    TIME,
        exchange      NVARCHAR(50),
        symbol        NVARCHAR(20),
        strategy      NVARCHAR(50),
        signal        NVARCHAR(10),
        side          NVARCHAR(10),
        quantity      DECIMAL(18,8),
        price         DECIMAL(18,2),
        total_usd     DECIMAL(18,2),
        fee_est       DECIMAL(18,4),
        net_amount    DECIMAL(18,2),
        order_id      NVARCHAR(100),
        mode          NVARCHAR(20),
        notes         NVARCHAR(500),
        created_at    DATETIME2 DEFAULT GETUTCDATE()
      )
    `);
    console.log("  Azure SQL: trades table ready.");
  } catch (err) {
    console.warn(`  Azure SQL init failed: ${err.message.split("\n")[0]}`);
  }
}

async function logTradeToSQL(logEntry) {
  if (!CONFIG.azureSQL.enabled) return;
  try {
    const pool = await getPool();
    const now = new Date(logEntry.timestamp);

    let side = null, quantity = null, totalUSD = null, fee = null,
        netAmount = null, orderId = null, mode, notes;

    if (!logEntry.allPass) {
      const failed = logEntry.conditions.filter((c) => !c.pass).map((c) => c.label).join("; ");
      mode = "BLOCKED"; orderId = "BLOCKED";
      notes = `Failed: ${failed}`;
    } else if (logEntry.paperTrading) {
      side = logEntry.signal === "long" ? "BUY" : "SELL";
      quantity = logEntry.tradeSize / logEntry.price;
      totalUSD = logEntry.tradeSize;
      fee = logEntry.tradeSize * 0.001;
      netAmount = logEntry.tradeSize - fee;
      orderId = logEntry.orderId || null;
      mode = "PAPER"; notes = "All conditions met";
    } else {
      side = logEntry.signal === "long" ? "BUY" : "SELL";
      quantity = logEntry.tradeSize / logEntry.price;
      totalUSD = logEntry.tradeSize;
      fee = logEntry.tradeSize * 0.001;
      netAmount = logEntry.tradeSize - fee;
      orderId = logEntry.orderId || null;
      mode = "LIVE";
      notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
    }

    const exchangeName = CONFIG.exchange === "coinbase" ? "Coinbase Advanced" : "BitGet";

    await pool.request()
      .input("trade_date",  sql.Date,           now)
      .input("trade_time",  sql.Time,            now)
      .input("exchange",    sql.NVarChar(50),    exchangeName)
      .input("symbol",      sql.NVarChar(20),    logEntry.symbol)
      .input("strategy",    sql.NVarChar(50),    logEntry.strategy)
      .input("signal",      sql.NVarChar(10),    logEntry.signal)
      .input("side",        sql.NVarChar(10),    side)
      .input("quantity",    sql.Decimal(18,8),   quantity)
      .input("price",       sql.Decimal(18,2),   logEntry.price)
      .input("total_usd",   sql.Decimal(18,2),   totalUSD)
      .input("fee_est",     sql.Decimal(18,4),   fee)
      .input("net_amount",  sql.Decimal(18,2),   netAmount)
      .input("order_id",    sql.NVarChar(100),   orderId)
      .input("mode",        sql.NVarChar(20),    mode)
      .input("notes",       sql.NVarChar(500),   notes)
      .query(`
        INSERT INTO trades
          (trade_date, trade_time, exchange, symbol, strategy, signal,
           side, quantity, price, total_usd, fee_est, net_amount,
           order_id, mode, notes)
        VALUES
          (@trade_date, @trade_time, @exchange, @symbol, @strategy, @signal,
           @side, @quantity, @price, @total_usd, @fee_est, @net_amount,
           @order_id, @mode, @notes)
      `);

    console.log("  Azure SQL: trade logged.");
  } catch (err) {
    console.warn(`  Azure SQL insert failed: ${err.message.split("\n")[0]}`);
  }
}

async function closeSQLPool() {
  if (sqlPool) { await sql.close(); sqlPool = null; }
}

// ─── CSV Logging ─────────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Column layout (0-indexed):
// 0:Date  1:Time  2:Exchange  3:Symbol  4:Strategy  5:Signal
// 6:Side  7:Quantity  8:Price  9:Total USD  10:Fee  11:Net Amount
// 12:Order ID  13:Mode  14:Notes
const CSV_HEADERS = [
  "Date", "Time (UTC)", "Exchange", "Symbol", "Strategy", "Signal",
  "Side", "Quantity", "Price", "Total USD", "Fee (est.)", "Net Amount",
  "Order ID", "Mode", "Notes",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const note = `,,,,,,,,,,,,,,,"NOTE: open this file in Google Sheets or Excel to compare strategies"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + note + "\n");
    console.log(`📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`);
  }
}

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "", quantity = "", totalUSD = "", fee = "", netAmount = "", orderId = "", mode = "", notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions.filter((c) => !c.pass).map((c) => c.label).join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = logEntry.signal === "long" ? "BUY" : "SELL";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = logEntry.signal === "long" ? "BUY" : "SELL";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const exchangeName = CONFIG.exchange === "coinbase" ? "Coinbase Advanced" : "BitGet";

  // RFC 4180 CSV escaping — prevents formula injection and malformed rows
  const csvField = (v) => {
    if (v == null) return "";
    const s = String(v);
    // Strip leading = + - @ to prevent spreadsheet formula injection
    const safe = s.replace(/^[=+\-@]/, "'$&");
    return safe.includes(",") || safe.includes('"') || safe.includes("\n")
      ? `"${safe.replace(/"/g, '""')}"`
      : safe;
  };

  const row = [
    date, time, exchangeName, logEntry.symbol,
    logEntry.strategy, logEntry.signal,
    side, quantity, logEntry.price.toFixed(2),
    totalUSD, fee, netAmount, orderId, mode, notes,
  ].map(csvField).join(",");

  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`  CSV row saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live    = rows.filter((r) => r[13] === "LIVE");
  const paper   = rows.filter((r) => r[13] === "PAPER");
  const blocked = rows.filter((r) => r[13] === "BLOCKED");
  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[9] || 0), 0);
  const totalFees   = live.reduce((sum, r) => sum + parseFloat(r[10] || 0), 0);

  const strategyKeys = ["vwap_scalp", "ema_cross", "bb_rsi", "macd"];

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log("\n  Strategy breakdown:");
  for (const s of strategyKeys) {
    const sPaper   = paper.filter((r) => r[4] === s).length;
    const sBlocked = blocked.filter((r) => r[4] === s).length;
    const sLive    = live.filter((r) => r[4] === s).length;
    console.log(`    ${s.padEnd(14)} paper=${sPaper}  blocked=${sBlocked}  live=${sLive}`);
  }
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Per-Symbol Processing ───────────────────────────────────────────────────

async function processSymbol(symbol, log) {
  console.log(`\n${"─".repeat(59)}`);
  console.log(`  ▶ ${symbol}`);
  console.log("─".repeat(59));

  // Fetch candles — 200 gives enough history for all indicators
  const candles = await fetchCandles(symbol, CONFIG.timeframe, 200);
  const closes     = candles.map((c) => c.close);
  const prevCloses = closes.slice(0, -1);
  const price      = closes[closes.length - 1];
  console.log(`\n  Current price: $${price.toFixed(2)}`);

  // ── Indicators ────────────────────────────────────────────────────────────
  const ema8      = calcEMA(closes, 8);
  const ema9      = calcEMA(closes, 9);
  const ema21     = calcEMA(closes, 21);
  const ema50     = calcEMA(closes, 50);
  const prevEma9  = calcEMA(prevCloses, 9);
  const prevEma21 = calcEMA(prevCloses, 21);
  const rsi3      = calcRSI(closes, 3);
  const rsi14     = calcRSI(closes, 14);
  const vwap      = calcVWAP(candles);
  const bb        = calcBollingerBands(closes);
  const macdData  = calcMACD(closes);
  const stochRSI  = calcStochRSI(closes);
  const supertrnd = calcSupertrend(candles);
  const ichimoku  = calcIchimoku(candles);
  const adxData   = calcADX(candles);
  const haCandles = calcHeikinAshi(candles);
  const orb       = calcOpeningRange(candles);
  const sr        = calcSupportResistance(candles);
  const vp        = calcVolumeProfile(candles);
  const rsiSeries = calcRSISeries(closes, 14);
  const divergence = calcRSIDivergence(closes, rsiSeries);

  console.log(`\n  EMA(8):   $${ema8?.toFixed(2)    ?? "N/A"}`);
  console.log(`  EMA(21):  $${ema21?.toFixed(2)   ?? "N/A"}`);
  console.log(`  EMA(50):  $${ema50?.toFixed(2)   ?? "N/A"}`);
  console.log(`  RSI(3):    ${rsi3?.toFixed(2)    ?? "N/A"}`);
  console.log(`  RSI(14):   ${rsi14?.toFixed(2)   ?? "N/A"}`);
  console.log(`  VWAP:     $${vwap?.toFixed(2)    ?? "N/A"}`);
  console.log(`  BB Lower: $${bb?.lower.toFixed(2) ?? "N/A"}`);
  console.log(`  BB Upper: $${bb?.upper.toFixed(2) ?? "N/A"}`);
  console.log(`  MACD:      ${macdData?.macd.toFixed(4)   ?? "N/A"}`);
  console.log(`  StochRSI K: ${stochRSI?.k.toFixed(2)    ?? "N/A"}`);
  console.log(`  Supertrend: $${supertrnd?.value.toFixed(2) ?? "N/A"} (${supertrnd?.direction === 1 ? "▲ bull" : "▼ bear"})`);
  console.log(`  ADX:       ${adxData?.adx.toFixed(2) ?? "N/A"} (+DI ${adxData?.plusDI.toFixed(2) ?? "N/A"} / -DI ${adxData?.minusDI.toFixed(2) ?? "N/A"})`);
  if (vp) console.log(`  POC:      $${vp.poc.toFixed(2)} | VAH $${vp.valueAreaHigh.toFixed(2)} | VAL $${vp.valueAreaLow.toFixed(2)}`);

  // ── Strategy Evaluation ───────────────────────────────────────────────────
  const strategies = [];
  if (vwap && rsi3 !== null && ema8)                                              strategies.push(evalVWAPScalp(price, ema8, vwap, rsi3));
  if (ema9 && ema21 && prevEma9 && prevEma21 && rsi14 !== null)                   strategies.push(evalEMACross(price, ema9, ema21, prevEma9, prevEma21, rsi14));
  if (bb && rsi14 !== null)                                                       strategies.push(evalBBRSI(price, bb, rsi14));
  if (macdData)                                                                   strategies.push(evalMACD(macdData));
  if (stochRSI)                                                                   strategies.push(evalStochRSI(stochRSI));
  if (supertrnd)                                                                  strategies.push(evalSupertrend(price, supertrnd));
  if (ichimoku)                                                                   strategies.push(evalIchimoku(price, ichimoku));
  if (divergence && rsi14 !== null)                                               strategies.push(evalRSIDivergence(divergence, rsi14));
  if (adxData)                                                                    strategies.push(evalADX(adxData));
  if (ema8 && ema21 && ema50)                                                     strategies.push(evalThreeEMA(price, ema8, ema21, ema50));
  if (haCandles.length >= 3)                                                      strategies.push(evalHeikinAshi(haCandles));
  if (orb)                                                                        strategies.push(evalORB(price, orb));
  if (sr && rsi14 !== null)                                                       strategies.push(evalSupportResistance(price, sr, rsi14));
  if (vp && rsi14 !== null)                                                       strategies.push(evalVolumeProfile(price, vp, rsi14));

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n── Strategy Summary ─────────────────────────────────────\n");
  for (const s of strategies) {
    const icon = s.allPass ? "✅" : "🚫";
    const exec = s.key === CONFIG.strategy ? " ← active" : "";
    console.log(`  ${icon} ${s.name.padEnd(32)} signal=${s.signal.padEnd(5)} ${s.allPass ? "FIRES" : "blocked"}${exec}`);
  }

  const tradeSize    = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);
  const withinLimits = checkTradeLimits(log, CONFIG.strategy, symbol);

  // ── Decisions ─────────────────────────────────────────────────────────────
  console.log("\n── Decisions ────────────────────────────────────────────\n");

  for (const s of strategies) {
    const isActive     = s.key === CONFIG.strategy;

    const logEntry = {
      timestamp:    new Date().toISOString(),
      symbol,
      timeframe:    CONFIG.timeframe,
      strategy:     s.key,
      strategyName: s.name,
      signal:       s.signal,
      price,
      conditions:   s.conditions,
      allPass:      s.allPass,
      tradeSize,
      orderPlaced:  false,
      orderId:      null,
      paperTrading: CONFIG.paperTrading,
      limits: {
        maxTradeSizeUSD:  CONFIG.maxTradeSizeUSD,
        maxTradesPerDay:  CONFIG.maxTradesPerDay,
        tradesToday:      countTodaysTrades(log, s.key, symbol),
      },
    };

    if (!s.allPass) {
      const failed = s.conditions.filter((c) => !c.pass).map((c) => c.label);
      console.log(`🚫 [${s.name}] ${isActive ? "(active — blocked)" : "(monitoring)"}`);
      failed.forEach((f) => console.log(`   - ${f}`));
    } else if (!isActive) {
      console.log(`📊 [${s.name}] SIGNAL fired — logged for comparison`);
    } else if (!withinLimits) {
      console.log(`🚫 [${s.name}] SIGNAL fired but daily limit reached for ${symbol}`);
    } else {
      console.log(`✅ [${s.name}] ALL CONDITIONS MET`);
      if (CONFIG.paperTrading) {
        const dir = s.signal === "long" ? "BUY" : "SELL";
        console.log(`\n📋 PAPER TRADE — ${dir} ${symbol} ~$${tradeSize.toFixed(2)} at market`);
        console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
        logEntry.orderPlaced = true;
        logEntry.orderId     = `PAPER-${Date.now()}`;
      } else {
        const side = s.signal === "long" ? "buy" : "sell";
        console.log(`\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${side.toUpperCase()} ${symbol}`);
        try {
          const order = await placeOrder(symbol, side, tradeSize, price);
          logEntry.orderPlaced = true;
          logEntry.orderId     = order.orderId;
          console.log(`✅ ORDER PLACED — ${order.orderId}`);
        } catch (err) {
          console.log(`❌ ORDER FAILED — ${err.message}`);
          logEntry.error = err.message;
        }
      }
    }

    log.trades.push(logEntry);
    writeTradeCsv(logEntry);
    await logTradeToSQL(logEntry);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  validateConfig();
  initCsv();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot — Multi-Strategy, Multi-Asset Edition");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode:     ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log(`  Assets:   ${CONFIG.symbols.join(", ")}`);
  console.log(`  Active:   ${CONFIG.strategy} (executes orders)`);
  console.log(`  Logging:  all 14 strategies × ${CONFIG.symbols.length} assets → trades.csv + Azure SQL`);
  console.log("═══════════════════════════════════════════════════════════");

  if (CONFIG.azureSQL.enabled) {
    console.log(`\n── Azure SQL ─────────────────────────────────────────────\n`);
    console.log(`  Server: ${CONFIG.azureSQL.server}`);
    await initAzureSQL();
  }

  const log = loadLog();

  for (const symbol of CONFIG.symbols) {
    try {
      await processSymbol(symbol, log);
    } catch (err) {
      console.error(`\n❌ Error processing ${symbol}: ${err.message}`);
    }
  }

  saveLog(log);
  await closeSQLPool();
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
