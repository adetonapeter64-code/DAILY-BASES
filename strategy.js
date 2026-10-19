
"use strict";

// DAILY BASES
// XAUUSD RSI Pullback + EMA Trend
// Timeframe: 15 minutes
// Candles: oldest to newest, UTC timestamps.

const CFG = {
  emaFast: 21,
  emaSlow: 100,
  rsiLen: 9,
  atrLen: 14,
  rsiBuyLevel: 45,
  rsiSellLevel: 55,
  slAtr: 1.5,
  rr: 2,
  sessionStartUTC: 7,
  sessionEndUTC: 20,
  cooldownMin: 60,
  maxPerDay: 5
};

function toMs(time) {
  if (typeof time !== "string") return NaN;

  const normalized = time.includes("T")
    ? time
    : time.replace(" ", "T") + "Z";

  const result = Date.parse(normalized);
  return Number.isFinite(result) ? result : NaN;
}

function ema(values, len) {
  const out = [];
  const k = 2 / (len + 1);
  let previous;

  for (let i = 0; i < values.length; i++) {
    const value = Number(values[i]);

    if (!Number.isFinite(value)) {
      out.push(null);
      continue;
    }

    previous = i === 0
      ? value
      : value * k + previous * (1 - k);

    out.push(previous);
  }

  return out;
}

function rsi(closes, len) {
  const out = new Array(closes.length).fill(null);

  if (closes.length <= len) return out;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i < closes.length; i++) {
    const difference = closes[i] - closes[i - 1];
    const up = Math.max(difference, 0);
    const down = Math.max(-difference, 0);

    if (i <= len) {
      gain += up;
      loss += down;

      if (i === len) {
        gain /= len;
        loss /= len;

        out[i] = loss === 0
          ? 100
          : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (len - 1) + up) / len;
      loss = (loss * (len - 1) + down) / len;

      out[i] = loss === 0
        ? 100
        : 100 - 100 / (1 + gain / loss);
    }
  }

  return out;
}

function atr(candles, len) {
  const out = new Array(candles.length).fill(null);
  let previousATR = null;
  let sum = 0;

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous.close),
      Math.abs(candle.low - previous.close)
    );

    if (i <= len) {
      sum += tr;

      if (i === len) {
        previousATR = sum / len;
        out[i] = previousATR;
      }
    } else {
      previousATR =
        (previousATR * (len - 1) + tr) / len;

      out[i] = previousATR;
    }
  }

  return out;
}

function precompute(candles, cfg = CFG) {
  if (!Array.isArray(candles)) {
    throw new Error("Candles must be an array");
  }

  const closes = candles.map(c => Number(c.close));

  return {
    closes,
    eFast: ema(closes, cfg.emaFast),
    eSlow: ema(closes, cfg.emaSlow),
    r: rsi(closes, cfg.rsiLen),
    a: atr(candles, cfg.atrLen)
  };
}

function evaluateAt(
  candles,
  i,
  state = { lastSignalMs: 0, countByDay: {} },
  cfg = CFG,
  indicators = precompute(candles, cfg)
) {
  if (i < cfg.emaSlow + 5 || i >= candles.length) {
    return null;
  }

  const { closes, eFast, eSlow, r, a } = indicators;

  if (
    r[i] == null ||
    r[i - 1] == null ||
    a[i] == null ||
    !Number.isFinite(a[i]) ||
    !Number.isFinite(eFast[i]) ||
    !Number.isFinite(eSlow[i])
  ) {
    return null;
  }

  const time = candles[i].time;
  const timestamp = toMs(time);

  if (!Number.isFinite(timestamp)) return null;

  const hour = new Date(timestamp).getUTCHours();

  if (
    hour < cfg.sessionStartUTC ||
    hour >= cfg.sessionEndUTC
  ) {
    return null;
  }

  state.lastSignalMs = Number(state.lastSignalMs) || 0;
  state.countByDay = state.countByDay || {};

  if (
    timestamp - state.lastSignalMs <
    cfg.cooldownMin * 60000
  ) {
    return null;
  }

  const day = time.slice(0, 10);

  if ((state.countByDay[day] || 0) >= cfg.maxPerDay) {
    return null;
  }

  const price = closes[i];

  const uptrend =
    price > eSlow[i] &&
    eFast[i] > eSlow[i];

  const downtrend =
    price < eSlow[i] &&
    eFast[i] < eSlow[i];

  const risk = a[i] * cfg.slAtr;

  if (!Number.isFinite(risk) || risk <= 0) return null;

  let side = null;

  if (
    uptrend &&
    r[i - 1] <= cfg.rsiBuyLevel &&
    r[i] > cfg.rsiBuyLevel
  ) {
    side = "BUY";
  } else if (
    downtrend &&
    r[i - 1] >= cfg.rsiSellLevel &&
    r[i] < cfg.rsiSellLevel
  ) {
    side = "SELL";
  }

  if (!side) return null;

  const direction = side === "BUY" ? 1 : -1;

  return {
    side,
    time,
    entry: price,
    sl: price - direction * risk,
    tp: price + direction * risk * cfg.rr,
    rsi: Math.round(r[i] * 10) / 10,
    atr: Math.round(a[i] * 100) / 100
  };
}

function checkSignal(
  candles,
  state = { lastSignalMs: 0, countByDay: {} },
  cfg = CFG
) {
  if (!candles.length) return null;

  return evaluateAt(
    candles,
    candles.length - 1,
    state,
    cfg,
    precompute(candles, cfg)
  );
}

module.exports = {
  CFG,
  checkSignal,
  evaluateAt,
  precompute,
  toMs
};
