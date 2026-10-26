"use strict";

// 🤖 BOT.XAU SNIPER ENTRY
// XAUUSD ONLY — M5 LIQUIDITY SWEEP + MSS + ORDER BLOCK (buy and sell)
//
// Route (sell side; buy side is the exact mirror):
//  1. Liquidity point : a swing high that has not been exceeded yet.
//  2. Sweep           : a candle wicks above it and CLOSES back below it.
//  3. Structure       : the swing low formed between the liquidity high and the sweep = MSS level.
//  4. MSS             : a candle CLOSES below the MSS level.
//  5. Order block     : the last bullish candle (against the trade) above the MSS, before the break.
//  6. Entry / SL      : limit at 50% of that candle, stop slightly above its high.
//  7. Target          : opposite-side liquidity (nearest unswept swing low).
//  8. Let it run      : fixed SL and TP (tracked by server.js), no trailing, no breakeven.
//
// Drop-in replacement for the old strategy.js: same exports, same signal fields.
// Candles: closed, oldest to newest, { time, open, high, low, close }. Times are UTC.

const CFG = {
  timeframe: "5min",
  pivotLeft: 3,          // candles to the left a swing high must beat
  liquidityLookback: 80, // max distance (candles) from the liquidity high to the sweep
  targetPivot: 10,       // strength of the swing low used as opposite-side liquidity
  recentBars: 3,         // only signal when the MSS break is within the last N closed candles
  atrLen: 14,
  slBufferAtr: 0.05,     // "slightly above the high" = 5% of ATR
  sessionStartUTC: 0,
  sessionEndUTC: 24,
  cooldownMin: 30,       // delivery limits from the old file, see notes: set 0 / 999 to disable
  maxPerDay: 3,
  setupExpiryMin: 240    // used by server.js to expire a limit that never fills
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

const maxOf = (arr, a, b) => Math.max(...arr.slice(a, b));
const minOf = (arr, a, b) => Math.min(...arr.slice(a, b));

// Sell-side route on plain arrays. The buy side runs this on mirrored (negated) prices.
function findSellSetups(o, h, l, c, slBuffer, cfg) {
  const LEFT = cfg.pivotLeft;
  const P = cfg.targetPivot;
  const n = h.length;
  const out = [];

  for (let s = Math.max(LEFT + 3, n - cfg.liquidityLookback); s < n - 1; s++) {
    // 1 + 2. liquidity high swept by candle s (wick above, close back below)
    let liq = null;
    for (let i = s - 3; i >= Math.max(LEFT, s - cfg.liquidityLookback); i--) {
      if (h[i] <= maxOf(h, i - LEFT, i)) continue;   // not a swing high
      if (h[i] < maxOf(h, i + 1, s)) continue;       // already exceeded before s
      if (h[i] < h[s] && c[s] < h[i]) { liq = i; break; }
    }
    if (liq === null) continue;

    // 3. MSS level = swing low between the liquidity high and the sweep
    const mss = minOf(l, liq + 1, s);

    // 4. MSS = first candle that CLOSES below it (invalid if the sweep high is taken out first)
    let b = null;
    for (let k = s + 1; k < n; k++) {
      if (h[k] > h[s]) break;
      if (c[k] < mss) { b = k; break; }
    }
    if (b === null) continue;

    // 5. order block = last bullish candle before the break, sitting above the MSS
    let ob = null;
    for (let k = b - 1; k >= s; k--) {
      if (c[k] > o[k]) { ob = k; break; }
    }
    if (ob === null || l[ob] <= mss) continue;

    // 6. entry at 50% of the candle, stop slightly above its high
    const entry = (h[ob] + l[ob]) / 2;
    const sl = h[ob] + slBuffer;

    // 7. target = nearest unswept swing low below entry (opposite-side liquidity)
    let tp = null;
    for (let j = b - P - 1; j >= P; j--) {
      if (l[j] < minOf(l, j - P, j) &&
          l[j] < minOf(l, j + 1, j + P + 1) &&
          l[j] < minOf(l, j + 1, b + 1) &&
          l[j] < entry) { tp = l[j]; break; }
    }
    if (tp === null || !(tp < entry && entry < sl)) continue;

    out.push({ sweepIndex: s, mssIndex: b, opposingIndex: ob, liq: h[liq], mss, entry, sl, tp });
  }

  return out;
}

function detectSetup(input, cfg = CFG) {
  const candles = validCandles(input);
  if (candles.length < 40) return null;

  const end = candles.length - 1;
  const atrValues = atr(candles, cfg.atrLen);
  const currentAtr = atrValues[end];
  if (!Number.isFinite(currentAtr) || currentAtr <= 0) return null;

  const slBuffer = currentAtr * cfg.slBufferAtr;

  const o = candles.map(x => x.open);
  const h = candles.map(x => x.high);
  const l = candles.map(x => x.low);
  const c = candles.map(x => x.close);

  const found = [];

  for (const s of findSellSetups(o, h, l, c, slBuffer, cfg)) {
    found.push({ ...s, side: "SELL" });
  }

  // BUY = exact mirror: negate prices, swap highs and lows, run the same route.
  const mo = o.map(v => -v), mh = l.map(v => -v), ml = h.map(v => -v), mc = c.map(v => -v);
  for (const s of findSellSetups(mo, mh, ml, mc, slBuffer, cfg)) {
    found.push({
      ...s, side: "BUY",
      liq: -s.liq, mss: -s.mss, entry: -s.entry, sl: -s.sl, tp: -s.tp
    });
  }

  // Only setups whose MSS break just happened (price may already have run on older ones).
  const fresh = found.filter(s => s.mssIndex >= end - cfg.recentBars);
  if (!fresh.length) return null;

  fresh.sort((a, b) => b.mssIndex - a.mssIndex);
  const pick = fresh[0];

  const opposing = candles[pick.opposingIndex];
  const risk = Math.abs(pick.entry - pick.sl);
  const rr = Math.abs(pick.tp - pick.entry) / risk;

  return {
    side: pick.side,
    time: candles[end].time,
    setupTime: candles[pick.mssIndex].time,
    sweepTime: candles[pick.sweepIndex].time,
    mssTime: candles[pick.mssIndex].time,
    opposingCandleTime: opposing.time,
    entry: pick.entry,
    sl: pick.sl,
    tp: pick.tp,
    rr: Number(rr.toFixed(2)),
    atr: Number(currentAtr.toFixed(2)),
    sweptLevel: pick.liq,
    brokenLevel: pick.mss,
    opposingCandle: {
      open: opposing.open,
      high: opposing.high,
      low: opposing.low,
      close: opposing.close
    },
    strategy: "M5 liquidity sweep + MSS + 50% order block + opposing liquidity TP"
  };
}

function evaluateSniper(
  m15Input,
  m5Input,
  m1Input,
  state = { lastSignalMs: 0, countByDay: {} },
  cfg = CFG
) {
  // Compatibility with server.js signature: M15 and M1 are ignored. M5 only.
  const candles = validCandles(m5Input);
  if (candles.length < 40) return null;

  const last = candles[candles.length - 1];
  const timestamp = toMs(last.time);
  if (!Number.isFinite(timestamp)) return null;

  const hour = new Date(timestamp).getUTCHours();
  if (hour < cfg.sessionStartUTC || hour >= cfg.sessionEndUTC) return null;

  state.lastSignalMs = Number(state.lastSignalMs) || 0;
  state.countByDay = state.countByDay || {};

  if (timestamp - state.lastSignalMs < cfg.cooldownMin * 60000) return null;

  const day = new Date(timestamp).toISOString().slice(0, 10);
  if ((state.countByDay[day] || 0) >= cfg.maxPerDay) return null;

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
