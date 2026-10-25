
"use strict";

// 🤖 BOT.XAU SNIPER ENTRY
// XAUUSD ONLY — M5 LIQUIDITY / MSS STRATEGY
//
// 1. Identify liquidity.
// 2. Wait for a liquidity sweep.
// 3. Determine direction from the sweep.
// 4. Wait for MSS.
// 5. Find the last opposing candle before MSS.
// 6. Entry at 50% of that candle; SL beyond its extreme.
// 7. TP at opposing-side liquidity.
// 8. Track the simulated trade until TP or SL.
//
// Candles: closed, oldest to newest. Times are UTC.

const CFG = {
  timeframe: "5min",
  swingLookback: 30,
  mssLookback: 8,
  sweepSearchBars: 8,
  opposingCandleSearchBars: 8,
  liquidityLookback: 80,
  atrLen: 14,
  slBufferAtr: 0.05,
  minRiskAtr: 0.10,
  maxRiskAtr: 8,
  sessionStartUTC: 0,
  sessionEndUTC: 24,
  cooldownMin: 30,
  maxPerDay: 3,
  setupExpiryMin: 240
};

function toMs(time) {
  if (typeof time !== "string") return NaN;
  const normalized = time.includes("T")
    ? time
    : time.replace(" ", "T") + "Z";
  const result = Date.parse(normalized);
  return Number.isFinite(result) ? result : NaN;
}

function validCandles(candles) {
  if (!Array.isArray(candles)) return [];

  return candles
    .filter(c =>
      c &&
      Number.isFinite(toMs(c.time)) &&
      [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
      c.high >= Math.max(c.open, c.close, c.low) &&
      c.low <= Math.min(c.open, c.close, c.high)
    )
    .sort((a, b) => toMs(a.time) - toMs(b.time));
}

function atr(candles, len = CFG.atrLen) {
  const result = new Array(candles.length).fill(null);
  let previous = null;
  let sum = 0;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );

    if (i <= len) {
      sum += tr;
      if (i === len) {
        previous = sum / len;
        result[i] = previous;
      }
    } else {
      previous = (previous * (len - 1) + tr) / len;
      result[i] = previous;
    }
  }

  return result;
}

// Find a confirmed pivot. A pivot must have candles on both sides.
function findSwingHigh(candles, index, left = 2, right = 2) {
  if (index - left < 0 || index + right >= candles.length) {
    return false;
  }

  const high = candles[index].high;

  for (let i = index - left; i <= index + right; i++) {
    if (i !== index && candles[i].high >= high) return false;
  }

  return true;
}

function findSwingLow(candles, index, left = 2, right = 2) {
  if (index - left < 0 || index + right >= candles.length) {
    return false;
  }

  const low = candles[index].low;

  for (let i = index - left; i <= index + right; i++) {
    if (i !== index && candles[i].low <= low) return false;
  }

  return true;
}

function getSwingLevels(candles, end, lookback = CFG.liquidityLookback) {
  const start = Math.max(2, end - lookback);
  const highs = [];
  const lows = [];

  for (let i = start; i <= end - 2; i++) {
    if (findSwingHigh(candles, i)) {
      highs.push({ price: candles[i].high, index: i });
    }

    if (findSwingLow(candles, i)) {
      lows.push({ price: candles[i].low, index: i });
    }
  }

  return { highs, lows };
}

function findNearestTarget(levels, entry, side) {
  const candidates = levels
    .map(level => level.price)
    .filter(price =>
      side === "BUY" ? price > entry : price < entry
    );

  if (!candidates.length) return null;

  return side === "BUY"
    ? Math.min(...candidates)
    : Math.max(...candidates);
}

function detectSetup(input, cfg = CFG) {
  const candles = validCandles(input);

  if (candles.length < Math.max(cfg.swingLookback, 40)) {
    return null;
  }

  const end = candles.length - 1;
  const current = candles[end];
  const currentTime = toMs(current.time);
  const atrValues = atr(candles, cfg.atrLen);
  const currentAtr = atrValues[end];

  if (!Number.isFinite(currentAtr) || currentAtr <= 0) {
    return null;
  }

  const swings = getSwingLevels(candles, end, cfg.liquidityLookback);

  // Use a confirmed liquidity level before the latest sweep candle.
  const sweepStart = Math.max(4, end - cfg.sweepSearchBars);

  for (let s = end - 2; s >= sweepStart; s--) {
    const earlierHighs = swings.highs.filter(level => level.index < s);
    const earlierLows = swings.lows.filter(level => level.index < s);

    const sweepCandle = candles[s];

    // Look for the most recent confirmed swing liquidity.
    const highLevel = earlierHighs.length
      ? earlierHighs[earlierHighs.length - 1]
      : null;

    const lowLevel = earlierLows.length
      ? earlierLows[earlierLows.length - 1]
      : null;

    let side = null;
    let sweptLevel = null;

    // BUY: price takes sell-side liquidity, then closes back above it.
    if (
      lowLevel &&
      sweepCandle.low < lowLevel.price &&
      sweepCandle.close > lowLevel.price
    ) {
      side = "BUY";
      sweptLevel = lowLevel.price;
    }

    // SELL: price takes buy-side liquidity, then closes back below it.
    if (
      !side &&
      highLevel &&
      sweepCandle.high > highLevel.price &&
      sweepCandle.close < highLevel.price
    ) {
      side = "SELL";
      sweptLevel = highLevel.price;
    }

    if (!side) continue;

    // Step 3 + 4: determine direction and wait for an MSS close.
    const mssEnd = Math.min(end, s + cfg.mssLookback);
    let mssIndex = -1;
    let brokenLevel = null;

    for (let j = s + 1; j <= mssEnd; j++) {
      const structureStart = Math.max(0, j - cfg.mssLookback);
      const structureCandles = candles.slice(structureStart, j);

      if (structureCandles.length < 2) continue;

      if (side === "BUY") {
        const previousHigh = Math.max(
          ...structureCandles.map(c => c.high)
        );

        if (candles[j].close > previousHigh) {
          mssIndex = j;
          brokenLevel = previousHigh;
          break;
        }
      } else {
        const previousLow = Math.min(
          ...structureCandles.map(c => c.low)
        );

        if (candles[j].close < previousLow) {
          mssIndex = j;
          brokenLevel = previousLow;
          break;
        }
      }
    }

    if (mssIndex < 0) continue;

    // Step 5: last candle against the trade direction before MSS.
    let opposingIndex = -1;
    const opposingStart = Math.max(
      s,
      mssIndex - cfg.opposingCandleSearchBars
    );

    for (let k = mssIndex - 1; k >= opposingStart; k--) {
      const c = candles[k];

      if (side === "BUY" && c.close < c.open) {
        opposingIndex = k;
        break;
      }

      if (side === "SELL" && c.close > c.open) {
        opposingIndex = k;
        break;
      }
    }

    if (opposingIndex < 0) continue;

    const opposing = candles[opposingIndex];

    // Step 6: midpoint of the last opposing candle.
    const entry = (opposing.high + opposing.low) / 2;
    const buffer = currentAtr * cfg.slBufferAtr;

    const sl = side === "BUY"
      ? opposing.low - buffer
      : opposing.high + buffer;

    const risk = Math.abs(entry - sl);

    if (
      !Number.isFinite(risk) ||
      risk < currentAtr * cfg.minRiskAtr ||
      risk > currentAtr * cfg.maxRiskAtr
    ) {
      continue;
    }

    // Step 7: target the nearest confirmed opposing-side liquidity.
    const targetLevels = side === "BUY"
      ? swings.highs.filter(level => level.index < s)
      : swings.lows.filter(level => level.index < s);

    const tp = findNearestTarget(targetLevels, entry, side);

    if (!Number.isFinite(tp)) continue;

    // Target must be beyond entry and on the profitable side of the trade.
    if (
      (side === "BUY" && tp <= entry) ||
      (side === "SELL" && tp >= entry)
    ) {
      continue;
    }

    const rr = Math.abs(tp - entry) / risk;

    // Don't impose a fixed RR requirement: TP is opposing-side liquidity.
    const setupTime = candles[mssIndex].time;

    return {
      side,
      time: current.time,
      setupTime,
      sweepTime: sweepCandle.time,
      mssTime: setupTime,
      opposingCandleTime: opposing.time,
      entry,
      sl,
      tp,
      rr: Number(rr.toFixed(2)),
      atr: Number(currentAtr.toFixed(2)),
      sweptLevel,
      brokenLevel,
      opposingCandle: {
        open: opposing.open,
        high: opposing.high,
        low: opposing.low,
        close: opposing.close
      },
      strategy: "M5 liquidity sweep + MSS + 50% opposing candle + opposing liquidity TP"
    };
  }

  return null;
}

function evaluateSniper(
  m15Input,
  m5Input,
  m1Input,
  state = { lastSignalMs: 0, countByDay: {} },
  cfg = CFG
) {
  // Compatibility with server.js signature:
  // M15 and M1 are deliberately ignored. The strategy uses M5 only.
  const candles = validCandles(m5Input);

  if (candles.length < 40) return null;

  const last = candles[candles.length - 1];
  const timestamp = toMs(last.time);

  if (!Number.isFinite(timestamp)) return null;

  const hour = new Date(timestamp).getUTCHours();

  if (hour < cfg.sessionStartUTC || hour >= cfg.sessionEndUTC) {
    return null;
  }

  state.lastSignalMs = Number(state.lastSignalMs) || 0;
  state.countByDay = state.countByDay || {};

  if (timestamp - state.lastSignalMs < cfg.cooldownMin * 60000) {
    return null;
  }

  const day = new Date(timestamp).toISOString().slice(0, 10);

  if ((state.countByDay[day] || 0) >= cfg.maxPerDay) {
    return null;
  }

  const setup = detectSetup(candles, cfg);

  if (!setup) return null;

  // Do not repeat the same setup on every polling cycle.
  const setupId = `${setup.side}:${setup.mssTime}:${setup.opposingCandleTime}`;

  if (state.lastSetupId === setupId) return null;

  state.lastSetupId = setupId;

  return setup;
}

function checkSignal(m15, m5, m1, state, cfg = CFG) {
  return evaluateSniper(m15, m5, m1, state, cfg);
}

module.exports = {
  CFG,
  checkSignal,
  evaluateSniper,
  toMs,
  validCandles,
  atr,
  detectSetup
};
