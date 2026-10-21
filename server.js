
"use strict";

// DAILY BASES v3.0.0
// XAUUSD 15M RSI Pullback + EMA Trend
//
// Required environment variables:
// TELEGRAM_BOT_TOKEN
// TWELVE_DATA_KEY
//
// Optional:
// TELEGRAM_CHAT_ID
// RENDER_EXTERNAL_URL
//
// This is a signal and simulated-trade tracker.
// It does not place broker orders.

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

const { CFG, evaluateAt, precompute, toMs } =
  require("./strategy");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TD_KEY = process.env.TWELVE_DATA_KEY;
const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

const TF_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

if (!TOKEN || !TD_KEY) {
  console.error(
    "Missing TELEGRAM_BOT_TOKEN or TWELVE_DATA_KEY."
  );
  process.exit(1);
}

const DEFAULT_DB = {
  chats: [],
  state: {
    lastSignalMs: 0,
    countByDay: {}
  },
  open: null,
  trades: [],
  lastSignal: null,
  lastEvaluated: ""
};

function loadDB() {
  try {
    const saved = JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );

    return {
      ...DEFAULT_DB,
      ...saved,
      chats: Array.isArray(saved.chats) ? saved.chats : [],
      trades: Array.isArray(saved.trades) ? saved.trades : [],
      state: {
        ...DEFAULT_DB.state,
        ...(saved.state || {}),
        countByDay: {
          ...((saved.state || {}).countByDay || {})
        }
      }
    };
  } catch (_) {
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

let db = loadDB();

if (process.env.TELEGRAM_CHAT_ID) {
  const id = String(process.env.TELEGRAM_CHAT_ID);

  if (!db.chats.includes(id)) {
    db.chats.push(id);
  }
}

function save() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(db, null, 2)
    );
  } catch (error) {
    console.error("Storage warning:", error.message);
  }
}

const status = {
  startedAt: new Date().toISOString(),
  lastCheck: null,
  lastCandle: null,
  error: null,
  nextCheck: null
};

const bot = new TelegramBot(TOKEN, { polling: true });

const KB = {
  reply_markup: {
    keyboard: [
      ["💰 Live Price", "📈 XAUUSD Signal"],
      ["🩺 Signal Status", "📊 Stats"]
    ],
    resize_keyboard: true
  }
};

const f2 = value => Number(value).toFixed(2);

async function notify(message) {
  for (const id of db.chats) {
    try {
      await bot.sendMessage(id, message, KB);
    } catch (error) {
      console.error(
        "Telegram send failed for",
        id,
        error.message
      );
    }
  }
}

// ---------------- MARKET DATA ----------------

async function fetchJSON(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(`Market API HTTP ${response.status}`);
  }

  return response.json();
}

async function fetchCandles() {
  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=XAU/USD" +
    "&interval=15min" +
    "&outputsize=300" +
    "&timezone=UTC" +
    `&apikey=${encodeURIComponent(TD_KEY)}`;

  const data = await fetchJSON(url);

  if (!Array.isArray(data.values)) {
    throw new Error(
      data.message || data.code || "No candle data returned"
    );
  }

  const now = Date.now();

  return data.values
    .map(c => ({
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .filter(c => {
      const time = toMs(c.time);

      return (
        Number.isFinite(time) &&
        time + TF_MS <= now + 1000 &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.high >= c.low
      );
    })
    .sort((a, b) => toMs(a.time) - toMs(b.time));
}

let priceCache = {
  time: 0,
  price: null
};

async function fetchPrice() {
  if (
    priceCache.price !== null &&
    Date.now() - priceCache.time < 20000
  ) {
    return priceCache.price;
  }

  const url =
    "https://api.twelvedata.com/price" +
    "?symbol=XAU/USD" +
    `&apikey=${encodeURIComponent(TD_KEY)}`;

  const data = await fetchJSON(url);
  const price = Number(data.price);

  if (!Number.isFinite(price)) {
    throw new Error(data.message || "Price unavailable");
  }

  priceCache = {
    time: Date.now(),
    price
  };

  return price;
}

// ---------------- TRADE TRACKING ----------------

function finishTrade(trade, r, reason, time, exit) {
  // Prevent duplicate closure if checks overlap.
  if (!trade || db.open !== trade) return;

  const closedTrade = {
    ...trade,
    r: Math.round(r * 100) / 100,
    why: reason,
    closed: time,
    exit
  };

  db.trades.push(closedTrade);
  db.open = null;

  // Keep the file manageable.
  if (db.trades.length > 2000) {
    db.trades = db.trades.slice(-2000);
  }

  save();

  const wins = db.trades.filter(t => t.r > 0).length;
  const net = db.trades.reduce((sum, t) => sum + t.r, 0);
  const winRate = db.trades.length
    ? Math.round(wins / db.trades.length * 100)
    : 0;

  notify(
    `${r > 0 ? "✅🏆 WIN" : r < 0 ? "❌ LOSS" : "⚪ BREAK EVEN"}` +
    ` — DAILY BASES\n\n` +
    `🥇 XAUUSD ${trade.side}\n` +
    `📍 Entry: ${f2(trade.entry)}\n` +
    `🏁 Exit: ${f2(exit)}\n` +
    `📌 Reason: ${reason}\n` +
    `💵 Result: ${r > 0 ? "+" : ""}${r.toFixed(2)}R\n\n` +
    `📊 Closed trades: ${db.trades.length}\n` +
    `🎯 Win rate: ${winRate}%\n` +
    `📈 Net result: ${net.toFixed(2)}R\n` +
    `🧪 Simulated tracking; not broker-confirmed.`
  );
}

function resolveOpen(candles) {
  const trade = db.open;
  if (!trade) return;

  const openTime = toMs(trade.time);

  for (const candle of candles) {
    const candleTime = toMs(candle.time);

    if (candleTime <= openTime) continue;

    const hitSL = trade.side === "BUY"
      ? candle.low <= trade.sl
      : candle.high >= trade.sl;

    const hitTP = trade.side === "BUY"
      ? candle.high >= trade.tp
      : candle.low <= trade.tp;

    // If both are touched in one candle, assume SL first.
    // OHLC candles cannot tell us the true intrabar order.
    if (hitSL) {
      finishTrade(
        trade, -1, hitTP ? "SL & TP SAME CANDLE (SL ASSUMED FIRST)" : "STOP LOSS",
        candle.time, trade.sl
      );
      return;
    }

    if (hitTP) {
      finishTrade(
        trade, CFG.rr, "TAKE PROFIT",
        candle.time, trade.tp
      );
      return;
    }

    if (candleTime - openTime >= DAY_MS) {
      const direction = trade.side === "BUY" ? 1 : -1;
      const risk = Math.abs(trade.entry - trade.sl);

      const r = risk > 0
        ? ((candle.close - trade.entry) * direction) / risk
        : 0;

      finishTrade(
        trade, r, "EXPIRED AFTER 24 HOURS",
        candle.time, candle.close
      );
      return;
    }
  }
}

async function checkProximity() {
  const trade = db.open;
  if (!trade) return;

  try {
    const price = await fetchPrice();

    // The quote endpoint may differ from the candle feed.
    // This is a monitoring estimate, not broker execution.
    const direction = trade.side === "BUY" ? 1 : -1;
    const risk = Math.abs(trade.entry - trade.sl);
    const reward = Math.abs(trade.tp - trade.entry);

    if (!risk || !reward) return;

    const toSL =
      ((trade.entry - price) * direction) / risk;

    const toTP =
      ((price - trade.entry) * direction) / reward;

    if (toSL >= 1) {
      finishTrade(
        trade, -1, "STOP LOSS (LIVE PRICE CHECK)",
        new Date().toISOString(), trade.sl
      );
      return;
    }

    if (toTP >= 1) {
      finishTrade(
        trade, CFG.rr, "TAKE PROFIT (LIVE PRICE CHECK)",
        new Date().toISOString(), trade.tp
      );
      return;
    }

    if (toSL >= 0.7 && !trade.warnSL) {
      trade.warnSL = true;

      notify(
        `⚠️ DAILY BASES — SL WARNING\n` +
        `XAUUSD ${trade.side}\n` +
        `💰 Current quote: ${f2(price)}\n` +
        `📍 Entry: ${f2(trade.entry)}\n` +
        `🛑 SL: ${f2(trade.sl)}`
      );

      save();
    }

    if (toTP >= 0.8 && !trade.warnTP) {
      trade.warnTP = true;

      notify(
        `🎯 DAILY BASES — TP APPROACHING\n` +
        `XAUUSD ${trade.side}\n` +
        `💰 Current quote: ${f2(price)}\n` +
        `🏁 TP: ${f2(trade.tp)}`
      );

      save();
    }
  } catch (error) {
    console.error("Proximity check failed:", error.message);
  }
}

// ---------------- SIGNAL ENGINE ----------------

let checking = false;

async function runCheck() {
  if (checking) return;

  checking = true;

  try {
    const candles = await fetchCandles();

    if (candles.length < CFG.emaSlow + 10) {
      throw new Error("Not enough closed candles for analysis");
    }

    const last = candles[candles.length - 1];
    status.lastCheck = new Date().toISOString();
    status.lastCandle = last.time;
    status.error = null;

    resolveOpen(candles);

    // One evaluation per closed candle.
    if (
      !db.open &&
      db.lastEvaluated !== last.time
    ) {
      // Save evaluation marker so repeated checks do not
      // produce duplicate signals for the same candle.
      db.lastEvaluated = last.time;

      const indicators = precompute(candles, CFG);

      const signal = evaluateAt(
        candles,
        candles.length - 1,
        db.state,
        CFG,
        indicators
      );

      if (signal) {
        db.state.lastSignalMs = toMs(signal.time);

        const day = signal.time.slice(0, 10);

        db.state.countByDay[day] =
          (db.state.countByDay[day] || 0) + 1;

        db.open = signal;
        db.lastSignal = signal;

        save();

        await notify(
          `🔔 DAILY BASES — NEW SIGNAL\n\n` +
          `${signal.side === "BUY" ? "🟢 BUY 📈" : "🔴 SELL 📉"} XAUUSD (15M)\n` +
          `📍 Entry: ${f2(signal.entry)}\n` +
          `🛑 Stop Loss: ${f2(signal.sl)}\n` +
          `🎯 Take Profit: ${f2(signal.tp)}\n` +
          `⚖️ Risk:Reward = 1:${CFG.rr}\n` +
          `📊 RSI: ${signal.rsi}\n` +
          `📏 ATR: ${signal.atr}\n` +
          `🕒 Candle: ${signal.time} UTC\n\n` +
          `🧪 Simulated signal. Verify before trading.`
        );
      }
    }

    save();
  } catch (error) {
    status.error = error.message;
    status.lastCheck = new Date().toISOString();

    console.error("DAILY BASES check failed:", error.message);
  } finally {
    checking = false;
  }
}

// ---------------- TELEGRAM MENUS ----------------

function statsText() {
  const trades = db.trades;
  const wins = trades.filter(t => t.r > 0).length;
  const losses = trades.filter(t => t.r < 0).length;
  const net = trades.reduce((sum, t) => sum + t.r, 0);

  const winRate = trades.length
    ? Math.round(wins / trades.length * 100)
    : 0;

  const recent = trades.slice(-5).reverse();

  const lastTrades = recent.length
    ? recent.map(t =>
        `${t.side} ${t.r > 0 ? "+" : ""}${t.r.toFixed(2)}R — ${t.why}`
      ).join("\n")
    : "No closed trades yet.";

  return (
    `📊 DAILY BASES — SIMULATED STATS\n\n` +
    `Closed trades: ${trades.length}\n` +
    `🏆 Wins: ${wins}\n` +
    `❌ Losses: ${losses}\n` +
    `🎯 Win rate: ${winRate}%\n` +
    `📈 Net: ${net.toFixed(2)}R\n` +
    `🟡 Active: ${db.open ? db.open.side : "None"}\n\n` +
    `Recent trades:\n${lastTrades}\n\n` +
    `Results are not broker-confirmed.`
  );
}

function signalText() {
  if (db.open) {
    const trade = db.open;

    return (
      `📡 DAILY BASES — ACTIVE SIGNAL\n\n` +
      `${trade.side === "BUY" ? "🟢 BUY" : "🔴 SELL"} XAUUSD (15M)\n` +
      `📍 Entry: ${f2(trade.entry)}\n` +
      `🛑 SL: ${f2(trade.sl)}\n` +
      `🎯 TP: ${f2(trade.tp)}\n` +
      `🕒 Opened: ${trade.time} UTC`
    );
  }

  if (db.lastSignal) {
    return (
      `😴 No active signal.\n\n` +
      `Last signal: ${db.lastSignal.side}\n` +
      `Entry: ${f2(db.lastSignal.entry)}\n` +
      `Candle: ${db.lastSignal.time} UTC`
    );
  }

  return "🔍 No signal recorded yet. DAILY BASES checks closed 15M candles.";
}

function statusText() {
  const hour = new Date().getUTCHours();
  const sessionOpen =
    hour >= CFG.sessionStartUTC &&
    hour < CFG.sessionEndUTC;

  const day = new Date().toISOString().slice(0, 10);

  return (
    `🩺 DAILY BASES — STATUS\n\n` +
    `Market data: ${status.error ? "❌ " + status.error : "✅ OK"}\n` +
    `Last check: ${status.lastCheck || "Not yet"}\n` +
    `Last candle: ${status.lastCandle || "N/A"} UTC\n` +
    `Next check: ${status.nextCheck || "Pending"}\n` +
    `Session: ${sessionOpen ? "🟢 Open" : "⚪ Closed"} UTC\n` +
    `Session hours: ${CFG.sessionStartUTC}:00–${CFG.sessionEndUTC}:00 UTC\n` +
    `Signals today: ${db.state.countByDay[day] || 0}/${CFG.maxPerDay}\n` +
    `Active trade: ${db.open ? db.open.side : "None"}\n` +
    `Telegram chats: ${db.chats.length}`
  );
}

bot.on("message", async message => {
  const id = String(message.chat.id);
  const text = (message.text || "").trim();

  if (!db.chats.includes(id)) {
    db.chats.push(id);
    save();
  }

  try {
    if (text === "/start") {
      return bot.sendMessage(
        id,
        `🚀 Welcome to DAILY BASES!\n\n` +
        `📊 Strategy: RSI pullback + EMA trend\n` +
        `🥇 Market: XAUUSD\n` +
        `⏱ Timeframe: 15 minutes\n` +
        `📩 Automatic signal notifications are enabled.\n\n` +
        `⚠️ Signals are not guaranteed to be profitable.`,
        KB
      );
    }

    if (text === "💰 Live Price" || text === "/price") {
      const price = await fetchPrice();

      return bot.sendMessage(
        id, `💰 XAUUSD: ${f2(price)}`, KB
      );
    }

    if (text === "📈 XAUUSD Signal" || text === "/signal") {
      return bot.sendMessage(id, signalText(), KB);
    }

    if (text === "🩺 Signal Status" || text === "/status") {
      return bot.sendMessage(id, statusText(), KB);
    }

    if (text === "📊 Stats" || text === "/stats") {
      return bot.sendMessage(id, statsText(), KB);
    }

    return bot.sendMessage(
      id,
      "🤖 Use the DAILY BASES buttons below.",
      KB
    );
  } catch (error) {
    return bot.sendMessage(
      id,
      `⚠️ Market data unavailable: ${error.message}`,
      KB
    );
  }
});

bot.on("polling_error", error => {
  console.error("Telegram polling error:", error.message);
});

// ---------------- SCHEDULING ----------------

// Check shortly after the next 15-minute boundary.
// This avoids fetching candles every few seconds.

function scheduleNextCheck(delayOverride) {
  const now = Date.now();
  const nextBoundary =
    (Math.floor(now / TF_MS) + 1) * TF_MS + 12000;

  const delay = Number.isFinite(delayOverride)
    ? delayOverride
    : Math.max(1000, nextBoundary - now);

  status.nextCheck = new Date(now + delay).toISOString();

  setTimeout(async () => {
    await runCheck();

    // Retry temporary API failures after one minute.
    scheduleNextCheck(status.error ? 60000 : undefined);
  }, delay);
}

setInterval(checkProximity, 3 * 60 * 1000);

const app = express();

app.get("/", (req, res) => {
  res.send("DAILY BASES is running.");
});

app.get("/health", (req, res) => {
  res.json({
    name: "DAILY BASES",
    ok: !status.error,
    ...status,
    activeTrade: db.open ? db.open.side : null,
    closedTrades: db.trades.length
  });
});

app.use(express.urlencoded({ extended: false }));

app.get("/backtest-download", (req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>DAILY BASES Data Export</title>
      <body style="font-family:Arial;padding:24px">
        <h2>📊 XAUUSD Historical Data</h2>
        <p>Enter your private export secret to download candles.</p>
        <form method="POST" action="/backtest-download">
          <input type="password" name="secret"
            placeholder="Export secret" required
            style="padding:12px;width:90%">
          <p><button style="padding:12px">Download candles</button></p>
        </form>
      </body>
    </html>
  `);
});

app.post("/backtest-download", async (req, res) => {
  const supplied = req.body && req.body.secret;
  const expected = process.env.BACKTEST_SECRET;

  if (!expected || typeof supplied !== "string" ||
      supplied.length !== expected.length ||
      supplied !== expected) {
    return res.status(401).send("Unauthorized.");
  }

  try {
    const url = new URL(
      "https://api.twelvedata.com/time_series"
    );

    url.searchParams.set("symbol", "XAU/USD");
    url.searchParams.set("interval", "15min");
    url.searchParams.set("outputsize", "5000");
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set("apikey", TD_KEY);

    const data = await fetchJSON(url.toString());

    if (!Array.isArray(data.values)) {
      throw new Error(
        data.message || "Historical candles unavailable."
      );
    }

    const candles = data.values
      .map(c => ({
        time: c.datetime,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      }))
      .filter(c => {
        const t = toMs(c.time);

        return Number.isFinite(t) &&
          t + TF_MS <= Date.now() &&
          [c.open, c.high, c.low, c.close]
            .every(Number.isFinite) &&
          c.high >= Math.max(c.open, c.close, c.low) &&
          c.low <= Math.min(c.open, c.close, c.high);
      })
      .sort((a, b) => toMs(a.time) - toMs(b.time));

    if (candles.length < 150) {
      throw new Error(
        `Only ${candles.length} closed candles available.`
      );
    }

    res.setHeader(
      "Content-Type",
      "application/json; charset=utf-8"
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="candles.json"'
    );

    res.send(JSON.stringify(candles, null, 2));
  } catch (error) {
    console.error("Historical export failed:", error.message);
    res.status(502).send(
      "Export failed. Check Render logs and Twelve Data API access."
    );
  }
});


app.listen(PORT, () => {
  console.log(`DAILY BASES listening on port ${PORT}`);
});

if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(
      process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "") +
      "/health"
    ).catch(() => {});
  }, 10 * 60 * 1000);
}

runCheck().finally(() => scheduleNextCheck());
