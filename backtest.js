
"use strict";

// DAILY BASES — Historical Strategy Backtester
// Uses the existing strategy.js.
// No real orders are placed.

const { CFG, evaluateAt, precompute, toMs } = require("./strategy");

const SETTINGS = {
  startingBalance: 10000,
  riskPercent: 0.5,
  spreadPrice: 0.30,
  slippagePrice: 0.10,
  commissionPerTrade: 0,
  candleFile: "./candles.json",
  outputFile: "./backtest-results.json"
};

const fs = require("fs");

function loadCandles() {
  if (!fs.existsSync(SETTINGS.candleFile)) {
    throw new Error(
      "Missing candles.json. Add historical XAUUSD candles first."
    );
  }

  const data = JSON.parse(
    fs.readFileSync(SETTINGS.candleFile, "utf8")
  );

  if (!Array.isArray(data)) {
    throw new Error("candles.json must contain a candle array.");
  }

  return data
    .map(c => ({
      time: c.time,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .filter(c =>
      Number.isFinite(toMs(c.time)) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.high >= c.low &&
      c.high >= Math.max(c.open, c.close) &&
      c.low <= Math.min(c.open, c.close)
    )
    .sort((a, b) => toMs(a.time) - toMs(b.time));
}

function runBacktest(candles) {
  const indicators = precompute(candles, CFG);
  const state = { lastSignalMs: 0, countByDay: {} };

  const trades = [];
  let balance = SETTINGS.startingBalance;
  let peak = balance;
  let maxDrawdownPercent = 0;
  let open = null;

  for (let i = CFG.emaSlow + 5; i < candles.length; i++) {
    const candle = candles[i];

    if (open) {
      const hitSL = open.side === "BUY"
        ? candle.low <= open.sl
        : candle.high >= open.sl;

      const hitTP = open.side === "BUY"
        ? candle.high >= open.tp
        : candle.low <= open.tp;

      if (hitSL || hitTP) {
        // Conservative assumption: SL first if both are hit.
        const exit = hitSL ? open.sl : open.tp;
        const grossR = hitSL ? -1 : CFG.rr;

        const riskCash =
          balance * SETTINGS.riskPercent / 100;

        const costPrice =
          SETTINGS.spreadPrice / 2 +
          SETTINGS.slippagePrice;

        const riskDistance = Math.abs(open.entry - open.sl);
        const costR = riskDistance > 0
          ? costPrice / riskDistance
          : 0;

        const netR = grossR - costR;
        const netProfit =
          riskCash * netR - SETTINGS.commissionPerTrade;

        balance += netProfit;
        peak = Math.max(peak, balance);

        const drawdown = peak > 0
          ? (peak - balance) / peak * 100
          : 0;

        maxDrawdownPercent = Math.max(
          maxDrawdownPercent, drawdown
        );

        trades.push({
          side: open.side,
          signalTime: open.time,
          exitTime: candle.time,
          entry: open.entry,
          sl: open.sl,
          tp: open.tp,
          exit,
          outcome: hitSL && hitTP
            ? "AMBIGUOUS_SL_ASSUMED_FIRST"
            : hitSL ? "LOSS" : "WIN",
          grossR,
          netR: Math.round(netR * 1000) / 1000,
          netProfit: Math.round(netProfit * 100) / 100,
          balance: Math.round(balance * 100) / 100
        });

        open = null;
        continue;
      }

      continue;
    }

    const signal = evaluateAt(
      candles, i, state, CFG, indicators
    );

    if (!signal) continue;

    state.lastSignalMs = toMs(signal.time);
    const day = signal.time.slice(0, 10);
    state.countByDay[day] =
      (state.countByDay[day] || 0) + 1;

    open = signal;
  }

  const wins = trades.filter(t => t.netProfit > 0).length;
  const losses = trades.filter(t => t.netProfit <= 0).length;
  const netProfit = trades.reduce(
    (sum, t) => sum + t.netProfit, 0
  );
  const grossWins = trades
    .filter(t => t.netProfit > 0)
    .reduce((sum, t) => sum + t.netProfit, 0);
  const grossLosses = Math.abs(trades
    .filter(t => t.netProfit < 0)
    .reduce((sum, t) => sum + t.netProfit, 0));

  const report = {
    symbol: "XAUUSD",
    strategy: "Existing RSI Pullback + EMA Trend",
    candlesTested: candles.length,
    closedTrades: trades.length,
    wins,
    losses,
    winRatePercent: trades.length
      ? Math.round(wins / trades.length * 10000) / 100
      : 0,
    netProfit: Math.round(netProfit * 100) / 100,
    endingBalance: Math.round(balance * 100) / 100,
    profitFactor: grossLosses
      ? Math.round(grossWins / grossLosses * 100) / 100
      : grossWins > 0 ? "No losses" : 0,
    maxDrawdownPercent:
      Math.round(maxDrawdownPercent * 100) / 100,
    settings: SETTINGS,
    note: "Research simulation only; not broker-confirmed. Open trades at the end are excluded."
  };

  fs.writeFileSync(
    SETTINGS.outputFile,
    JSON.stringify({ report, trades }, null, 2)
  );

  console.log("\nDAILY BASES BACKTEST RESULTS\n");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nSaved detailed results to ${SETTINGS.outputFile}`);

  return report;
}

try {
  const candles = loadCandles();

  if (candles.length < CFG.emaSlow + 50) {
    throw new Error(
      "Too few candles. Supply at least 150 valid historical candles; more is preferable."
    );
  }

  runBacktest(candles);
} catch (error) {
  console.error("\nBACKTEST ERROR:", error.message);
  process.exitCode = 1;
}
