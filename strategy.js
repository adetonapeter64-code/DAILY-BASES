// RSI Pullback + EMA Trend strategy for XAUUSD (15M candles)
// candles: array oldest -> newest, each { time: "YYYY-MM-DD HH:mm:ss" (UTC), open, high, low, close }

const CFG = {
  emaFast: 21,
  emaSlow: 100,
  rsiLen: 9, 
  atrLen: 14,
  rsiBuyLevel: 45,   // buy when RSI crosses back UP through this
  rsiSellLevel: 55,  // sell when RSI crosses back DOWN through this
  slAtr: 1.5,        // stop = 1.5 x ATR
  rr: 2,             // take profit = 2 x risk
  sessionStartUTC: 7,
  sessionEndUTC: 20,
  cooldownMin: 60,   // min gap between signals
  maxPerDay: 5,
};

function ema(values, len) {
  const k = 2 / (len + 1);
  const out = [];
  let prev;
  values.forEach((v, i) => {
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

function rsi(closes, len) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= len) {
      gain += g; loss += l;
      if (i === len) {
        gain /= len; loss /= len;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (len - 1) + g) / len;
      loss = (loss * (len - 1) + l) / len;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

function atr(candles, len) {
  const out = new Array(candles.length).fill(null);
  let sum = 0, prev = null;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i <= len) {
      sum += tr;
      if (i === len) { prev = sum / len; out[i] = prev; }
    } else {
      prev = (prev * (len - 1) + tr) / len;
      out[i] = prev;
    }
  }
  return out;
}

const toMs = (t) => Date.parse(t.replace(" ", "T") + "Z");

// Evaluate the LAST closed candle. state = { lastSignalMs, countByDay: { "YYYY-MM-DD": n } }
function checkSignal(candles, state = { lastSignalMs: 0, countByDay: {} }, cfg = CFG) {
  return evaluateAt(candles, candles.length - 1, state, cfg, precompute(candles, cfg));
}

function precompute(candles, cfg = CFG) {
  const closes = candles.map((c) => Number(c.close));
  return {
    closes,
    eFast: ema(closes, cfg.emaFast),
    eSlow: ema(closes, cfg.emaSlow),
    r: rsi(closes, cfg.rsiLen),
    a: atr(candles, cfg.atrLen),
  };
}

function evaluateAt(candles, i, state, cfg, ind) {
  if (i < cfg.emaSlow + 5) return null;
  const { closes, eFast, eSlow, r, a } = ind;
  if (r[i] == null || r[i - 1] == null || a[i] == null) return null;

  const t = toMs(candles[i].time);
  const hour = new Date(t).getUTCHours();
  if (hour < cfg.sessionStartUTC || hour >= cfg.sessionEndUTC) return null;
  if (t - state.lastSignalMs < cfg.cooldownMin * 60000) return null;
  const day = candles[i].time.slice(0, 10);
  if ((state.countByDay[day] || 0) >= cfg.maxPerDay) return null;

  const price = closes[i];
  const up = price > eSlow[i] && eFast[i] > eSlow[i];
  const down = price < eSlow[i] && eFast[i] < eSlow[i];
  const risk = a[i] * cfg.slAtr;
  let side = null;

  if (up && r[i - 1] <= cfg.rsiBuyLevel && r[i] > cfg.rsiBuyLevel) side = "BUY";
  if (down && r[i - 1] >= cfg.rsiSellLevel && r[i] < cfg.rsiSellLevel) side = "SELL";
  if (!side) return null;

  const dir = side === "BUY" ? 1 : -1;
  return {
    side,
    time: candles[i].time,
    entry: price,
    sl: price - dir * risk,
    tp: price + dir * risk * cfg.rr,
    rsi: Math.round(r[i] * 10) / 10,
    atr: Math.round(a[i] * 100) / 100,
  };
}

module.exports = { CFG, checkSignal, evaluateAt, precompute };
