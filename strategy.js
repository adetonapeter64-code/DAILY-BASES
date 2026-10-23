"use strict";

// XAUUSD STRICT SNIPER v1.0
// Rule-based multi-timeframe strategy:
// M15 trend -> M5 liquidity sweep + structure shift + displacement/FVG
// -> M1 FVG retest + candle confirmation.
// Candles must be closed and sorted oldest to newest. Times are UTC.

const CFG = {
  rr: 3,
  sessionStartUTC: 7,
  sessionEndUTC: 20,
  cooldownMin: 30,
  maxPerDay: 3,
  emaFast: 21,
  emaSlow: 100,
  atrLen: 14,
  swingLookback: 8,
  sweepLookback: 12,
  fvgLookback: 8,
  slAtrBuffer: 0.15,
  minRiskAtr: 0.25,
  maxRiskAtr: 2.5,
  minDisplacementBodyAtr: 0.45
};

function toMs(time) {
  if (typeof time !== "string") return NaN;
  const normalized = time.includes("T") ? time : time.replace(" ", "T") + "Z";
  const result = Date.parse(normalized);
  return Number.isFinite(result) ? result : NaN;
}

function ema(values, len) {
  const out = [];
  const k = 2 / (len + 1);
  let previous;
  for (let i = 0; i < values.length; i++) {
    const value = Number(values[i]);
    if (!Number.isFinite(value)) { out.push(null); continue; }
    previous = i === 0 ? value : value * k + previous * (1 - k);
    out.push(previous);
  }
  return out;
}

function atr(candles, len = CFG.atrLen) {
  const out = new Array(candles.length).fill(null);
  let previousATR = null;
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i <= len) {
      sum += tr;
      if (i === len) { previousATR = sum / len; out[i] = previousATR; }
    } else {
      previousATR = (previousATR * (len - 1) + tr) / len;
      out[i] = previousATR;
    }
  }
  return out;
}

function validCandles(candles) {
  return Array.isArray(candles) ? candles.filter(c =>
    c && Number.isFinite(toMs(c.time)) &&
    [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= Math.max(c.open, c.close, c.low) &&
    c.low <= Math.min(c.open, c.close, c.high)
  ).sort((a, b) => toMs(a.time) - toMs(b.time)) : [];
}

function trendAt(m15) {
  if (m15.length < CFG.emaSlow + 5) return null;
  const closes = m15.map(c => c.close);
  const fast = ema(closes, CFG.emaFast);
  const slow = ema(closes, CFG.emaSlow);
  const i = m15.length - 1;
  if (!Number.isFinite(fast[i]) || !Number.isFinite(slow[i])) return null;
  if (closes[i] > slow[i] && fast[i] > slow[i] && fast[i] > fast[i - 3]) return "BUY";
  if (closes[i] < slow[i] && fast[i] < slow[i] && fast[i] < fast[i - 3]) return "SELL";
  return null;
}

function averageBody(candles, end, count = 10) {
  const start = Math.max(0, end - count);
  const bodies = candles.slice(start, end).map(c => Math.abs(c.close - c.open));
  return bodies.length ? bodies.reduce((a, b) => a + b, 0) / bodies.length : 0;
}

function findM5Setup(m5, side) {
  // Recent liquidity sweep followed by a close through short-term structure,
  // with a directional displacement candle and a three-candle FVG.
  if (m5.length < 30) return null;
  const end = m5.length - 1;
  const start = Math.max(2, end - CFG.sweepLookback);
  const atrs = atr(m5, CFG.atrLen);
  const currentAtr = atrs[end];
  if (!Number.isFinite(currentAtr) || currentAtr <= 0) return null;

  for (let s = end - 2; s >= start; s--) {
    const beforeStart = Math.max(0, s - CFG.swingLookback);
    const prior = m5.slice(beforeStart, s);
    if (prior.length < 4) continue;
    const priorHigh = Math.max(...prior.map(c => c.high));
    const priorLow = Math.min(...prior.map(c => c.low));
    const sweep = m5[s];

    if (side === "BUY") {
      if (!(sweep.low < priorLow && sweep.close > priorLow)) continue;
      for (let j = s + 1; j <= Math.min(end, s + 3); j++) {
        const structureHigh = Math.max(...m5.slice(Math.max(0, s - 4), s).map(c => c.high));
        const c = m5[j];
        const body = Math.abs(c.close - c.open);
        if (c.close <= structureHigh || c.close <= c.open || body < currentAtr * CFG.minDisplacementBodyAtr) continue;
        // Bullish FVG: low of current candle above high two candles earlier.
        let fvg = null;
        for (let k = Math.max(s + 2, j - 2); k <= j; k++) {
          if (k >= 2 && m5[k].low > m5[k - 2].high) {
            fvg = { low: m5[k - 2].high, high: m5[k].low, time: m5[k].time };
          }
        }
        if (fvg) return { side, sweep: sweep.low, structure: structureHigh, fvg, atr: currentAtr, setupTime: c.time };
      }
    } else {
      if (!(sweep.high > priorHigh && sweep.close < priorHigh)) continue;
      for (let j = s + 1; j <= Math.min(end, s + 3); j++) {
        const structureLow = Math.min(...m5.slice(Math.max(0, s - 4), s).map(c => c.low));
        const c = m5[j];
        const body = Math.abs(c.close - c.open);
        if (c.close >= structureLow || c.close >= c.open || body < currentAtr * CFG.minDisplacementBodyAtr) continue;
        let fvg = null;
        for (let k = Math.max(s + 2, j - 2); k <= j; k++) {
          if (k >= 2 && m5[k].high < m5[k - 2].low) {
            fvg = { low: m5[k].high, high: m5[k - 2].low, time: m5[k].time };
          }
        }
        if (fvg) return { side, sweep: sweep.high, structure: structureLow, fvg, atr: currentAtr, setupTime: c.time };
      }
    }
  }
  return null;
}

function m1Confirmation(m1, setup) {
  if (m1.length < 20) return null;
  const c = m1[m1.length - 1];
  const p = m1[m1.length - 2];
  const fvg = setup.fvg;
  const overlaps = c.low <= fvg.high && c.high >= fvg.low;
  if (!overlaps) return null;

  if (setup.side === "BUY") {
    if (c.close <= c.open || c.close <= fvg.low || c.close <= p.high) return null;
  } else {
    if (c.close >= c.open || c.close >= fvg.high || c.close >= p.low) return null;
  }
  return c;
}

function evaluateSniper(m15Input, m5Input, m1Input, state = { lastSignalMs: 0, countByDay: {} }, cfg = CFG) {
  const m15 = validCandles(m15Input), m5 = validCandles(m5Input), m1 = validCandles(m1Input);
  if (m15.length < cfg.emaSlow + 5 || m5.length < 30 || m1.length < 20) return null;

  const candle = m1[m1.length - 1];
  const timestamp = toMs(candle.time);
  if (!Number.isFinite(timestamp)) return null;
  const hour = new Date(timestamp).getUTCHours();
  if (hour < cfg.sessionStartUTC || hour >= cfg.sessionEndUTC) return null;

  state.lastSignalMs = Number(state.lastSignalMs) || 0;
  state.countByDay = state.countByDay || {};
  if (timestamp - state.lastSignalMs < cfg.cooldownMin * 60000) return null;
  const day = new Date(timestamp).toISOString().slice(0, 10);
  if ((state.countByDay[day] || 0) >= cfg.maxPerDay) return null;

  const side = trendAt(m15);
  if (!side) return null;

  // M5 must agree with the current M15 trend and provide sweep + shift + FVG.
  const setup = findM5Setup(m5, side);
  if (!setup) return null;

  // Do not use an old setup: require its M5 setup candle to be recent.
  const setupAge = timestamp - toMs(setup.setupTime);
  if (!Number.isFinite(setupAge) || setupAge < 0 || setupAge > 20 * 60000) return null;

  const confirmation = m1Confirmation(m1, setup);
  if (!confirmation) return null;

  const currentAtrArr = atr(m1, cfg.atrLen);
  const currentAtr = currentAtrArr[currentAtrArr.length - 1];
  if (!Number.isFinite(currentAtr) || currentAtr <= 0) return null;

  const entry = confirmation.close;
  const buffer = currentAtr * cfg.slAtrBuffer;
  const rawSL = side === "BUY" ? Math.min(setup.sweep, confirmation.low) - buffer : Math.max(setup.sweep, confirmation.high) + buffer;
  const risk = Math.abs(entry - rawSL);
  if (!Number.isFinite(risk) || risk < currentAtr * cfg.minRiskAtr || risk > currentAtr * cfg.maxRiskAtr) return null;

  const sl = rawSL;
  const tp = side === "BUY" ? entry + risk * cfg.rr : entry - risk * cfg.rr;
  return {
    side, time: candle.time, entry, sl, tp, rr: cfg.rr,
    rsi: null, atr: Math.round(currentAtr * 100) / 100,
    strategy: "M15 trend + M5 sweep/CHOCH/FVG + M1 retest",
    setupTime: setup.setupTime,
    fvg: setup.fvg
  };
}

function checkSignal(m15, m5, m1, state, cfg = CFG) {
  return evaluateSniper(m15, m5, m1, state, cfg);
}

module.exports = { CFG, checkSignal, evaluateSniper, toMs, validCandles };
