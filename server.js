
"use strict";

require("dotenv").config();

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { CFG, evaluateSniper, toMs, validCandles } = require("./strategy");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.TWELVE_DATA_KEY;
const DEFAULT_CHAT = process.env.TELEGRAM_CHAT_ID;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");

app.use(express.json());

if (!TOKEN || !API_KEY) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN or TWELVE_DATA_KEY");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

const KEYBOARD = {
  reply_markup: {
    keyboard: [
      ["💰 Live Price", "📈 XAUUSD Signal"],
      ["🩺 Signal Status", "📊 Stats"]
    ],
    resize_keyboard: true
  }
};

function freshDB() {
  return {
    chats: DEFAULT_CHAT ? [String(DEFAULT_CHAT)] : [],
    state: {
      lastSignalMs: 0,
      countByDay: {},
      lastSetupId: null
    },
    open: [],
    trades: [],
    lastSignal: null,
    lastEvaluated: null
  };
}

function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      const base = freshDB();

      return {
        ...base,
        ...parsed,
        chats: Array.isArray(parsed.chats) ? parsed.chats : base.chats,
        state: { ...base.state, ...(parsed.state || {}) },
        open: Array.isArray(parsed.open) ? parsed.open : [],
        trades: Array.isArray(parsed.trades) ? parsed.trades : []
      };
    }
  } catch (error) {
    console.error("⚠️ Could not load data.json:", error.message);
  }

  return freshDB();
}

let db = loadDB();

function saveDB() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (error) {
    console.error("❌ Could not save data:", error.message);
  }
}

function money(value) {
  return Number(value).toFixed(2);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  })[character]);
}

async function notify(message) {
  const chats = [...new Set([
    ...(db.chats || []),
    ...(DEFAULT_CHAT ? [String(DEFAULT_CHAT)] : [])
  ])];

  for (const chatId of chats) {
    try {
      await bot.sendMessage(chatId, message, {
        parse_mode: "HTML",
        ...KEYBOARD
      });
    } catch (error) {
      console.error(`⚠️ Telegram send failed for ${chatId}:`, error.message);
    }
  }
}

async function fetchJSON(url) {
  const response = await fetch(url);
  const body = await response.json();

  if (!response.ok || body.status === "error" || body.code) {
    throw new Error(
      body.message || body.error || `API error ${response.status}`
    );
  }

  return body;
}

async function fetchM5Candles(outputsize = 500) {
  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", "XAU/USD");
  url.searchParams.set("interval", "5min");
  url.searchParams.set("outputsize", String(outputsize));
  url.searchParams.set("order", "ASC");
  url.searchParams.set("apikey", API_KEY);

  const body = await fetchJSON(url.toString());

  if (!Array.isArray(body.values)) {
    throw new Error(body.message || "No M5 candles returned by Twelve Data");
  }

  const candles = body.values.map(c => ({
    time: c.datetime,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  }));

  // Remove the currently forming M5 candle.
  const now = Date.now();
  const closed = validCandles(candles).filter(c => {
    const time = toMs(c.time);
    return Number.isFinite(time) && time + 5 * 60000 <= now;
  });

  return closed;
}

async function fetchGoldPrice() {
  const url = new URL("https://api.twelvedata.com/price");

  url.searchParams.set("symbol", "XAU/USD");
  url.searchParams.set("apikey", API_KEY);

  const body = await fetchJSON(url.toString());
  const price = Number(body.price);

  if (!Number.isFinite(price)) {
    throw new Error("Invalid gold price from Twelve Data");
  }

  return price;
}

function formatSignal(signal, status = "PENDING LIMIT ENTRY") {
  return [
    "🤖 <b>BOT.XAU SNIPER ENTRY</b> 🥇",
    "",
    signal.side === "BUY" ? "🟢 <b>BUY LIMIT SETUP</b>" : "🔴 <b>SELL LIMIT SETUP</b>",
    `📍 <b>Status:</b> ${escapeHtml(status)}`,
    "⏱️ <b>Timeframe:</b> M5",
    "",
    `🎯 <b>Entry (50% candle):</b> ${money(signal.entry)}`,
    `🛑 <b>Stop Loss:</b> ${money(signal.sl)}`,
    `💰 <b>Liquidity Target:</b> ${money(signal.tp)}`,
    `⚖️ <b>Potential R:R:</b> 1:${Number(signal.rr).toFixed(2)}`,
    "",
    `💧 <b>Swept liquidity:</b> ${money(signal.sweptLevel)}`,
    `🔀 <b>MSS level:</b> ${money(signal.brokenLevel)}`,
    `🕯️ <b>Last opposing candle:</b> ${escapeHtml(signal.opposingCandleTime)}`,
    `📊 <b>ATR:</b> ${money(signal.atr)}`,
    "",
    "🧠 <b>Method:</b> Sweep → MSS → 50% candle → opposite liquidity",
    "⚠️ This is a signal, not a broker order. Wait for price to reach the limit entry.",
    "🔥 Trade carefully; no setup guarantees profit."
  ].join("\n");
}

function closeTrade(trade, outcome, exitPrice, exitTime) {
  if (trade.status === "TP" || trade.status === "SL" || trade.status === "EXPIRED") {
    return;
  }

  trade.status = outcome;
  trade.exitPrice = exitPrice;
  trade.exitTime = exitTime;
  trade.rResult = outcome === "TP"
    ? trade.rr
    : outcome === "SL"
      ? -1
      : 0;

  trade.resultMessage = outcome === "TP"
    ? "🎯 <b>TAKE PROFIT HIT!</b> 🥳"
    : outcome === "SL"
      ? "🛑 <b>STOP LOSS HIT</b> 📉"
      : "⌛ <b>SETUP EXPIRED</b>";

  db.trades.push({
    ...trade,
    closedAt: new Date().toISOString()
  });

  db.open = db.open.filter(item => item.id !== trade.id);
  saveDB();

  notify([
    "🤖 <b>BOT.XAU TRADE UPDATE</b> 🥇",
    "",
    trade.side === "BUY" ? "🟢 BUY" : "🔴 SELL",
    trade.resultMessage,
    `📍 <b>Entry:</b> ${money(trade.entry)}`,
    `🚪 <b>Exit:</b> ${money(exitPrice)}`,
    `📊 <b>Result:</b> ${outcome}`,
    `⚖️ <b>R result:</b> ${trade.rResult > 0 ? "+" : ""}${money(trade.rResult)}R`,
    "",
    "🧾 Simulated trade tracking only."
  ].join("\n"));
}

function resolveOpen(candles) {
  if (!candles.length) return;

  const now = Date.now();

  for (const trade of [...db.open]) {
    const setupMs = toMs(trade.setupTime);

    if (
      Number.isFinite(setupMs) &&
      now - setupMs > CFG.setupExpiryMin * 60000 &&
      trade.status === "PENDING"
    ) {
      closeTrade(trade, "EXPIRED", trade.entry, new Date().toISOString());
      continue;
    }

    const later = candles.filter(c => {
      const time = toMs(c.time);
      return Number.isFinite(time) && time > (Number(trade.lastCheckedMs) || 0);
    });

    for (const candle of later) {
      const candleMs = toMs(candle.time);

      if (trade.status === "PENDING") {
        const entryTouched =
          candle.low <= trade.entry && candle.high >= trade.entry;

        if (entryTouched) {
          trade.status = "ACTIVE";
          trade.entryTime = candle.time;
          trade.lastCheckedMs = candleMs;
          saveDB();

          notify([
            "🤖 <b>BOT.XAU ENTRY UPDATE</b> 🥇",
            "",
            "✅ <b>LIMIT ENTRY TOUCHED</b>",
            trade.side === "BUY" ? "🟢 BUY LIMIT" : "🔴 SELL LIMIT",
            `🎯 <b>Entry:</b> ${money(trade.entry)}`,
            `🛑 <b>SL:</b> ${money(trade.sl)}`,
            `💰 <b>TP:</b> ${money(trade.tp)}`,
            "",
            "📊 Simulated trade is now active."
          ].join("\n"));

          // The entry candle may also have reached SL/TP.
          const hitSL = trade.side === "BUY"
            ? candle.low <= trade.sl
            : candle.high >= trade.sl;

          const hitTP = trade.side === "BUY"
            ? candle.high >= trade.tp
            : candle.low <= trade.tp;

          if (hitSL) {
            closeTrade(trade, "SL", trade.sl, candle.time);
            break;
          }

          if (hitTP) {
            closeTrade(trade, "TP", trade.tp, candle.time);
            break;
          }
        }
      } else if (trade.status === "ACTIVE") {
        const hitSL = trade.side === "BUY"
          ? candle.low <= trade.sl
          : candle.high >= trade.sl;

        const hitTP = trade.side === "BUY"
          ? candle.high >= trade.tp
          : candle.low <= trade.tp;

        // Conservative rule when both levels are hit in one candle.
        if (hitSL) {
          closeTrade(trade, "SL", trade.sl, candle.time);
          break;
        }

        if (hitTP) {
          closeTrade(trade, "TP", trade.tp, candle.time);
          break;
        }
      }

      trade.lastCheckedMs = candleMs;
    }
  }

  saveDB();
}

async function runCheck() {
  try {
    const candles = await fetchM5Candles(500);

    if (candles.length < 40) {
      console.log("⏳ Waiting for enough closed M5 candles");
      return;
    }

    resolveOpen(candles);

    const lastCandle = candles[candles.length - 1];
    const lastCandleMs = toMs(lastCandle.time);

    if (
      !Number.isFinite(lastCandleMs) ||
      db.lastEvaluated === lastCandle.time
    ) {
      return;
    }

    db.lastEvaluated = lastCandle.time;

    // The strategy accepts the old function signature for compatibility,
    // but uses only the M5 candles.
    const signal = evaluateSniper(
      [],
      candles,
      [],
      db.state,
      CFG
    );

    if (!signal) {
      saveDB();
      return;
    }

    // Do not create another setup while a simulated setup is still open.
    if (db.open.length > 0) {
      saveDB();
      return;
    }

    const setupId = [
      signal.side,
      signal.mssTime,
      signal.opposingCandleTime
    ].join(":");

    if (db.lastSignal && db.lastSignal.setupId === setupId) {
      saveDB();
      return;
    }

    const trade = {
      id: `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
      ...signal,
      setupId,
      status: "PENDING",
      createdAt: new Date().toISOString(),
      lastCheckedMs: lastCandleMs
    };

    db.open.push(trade);
    db.lastSignal = {
      ...signal,
      setupId,
      sentAt: new Date().toISOString()
    };

    db.state.lastSignalMs = lastCandleMs;
    db.state.countByDay = db.state.countByDay || {};

    const day = new Date(lastCandleMs).toISOString().slice(0, 10);
    db.state.countByDay[day] = (db.state.countByDay[day] || 0) + 1;
    db.state.lastSetupId = setupId;

    saveDB();
    await notify(formatSignal(signal));
    console.log(`📣 Signal sent: ${signal.side} at ${signal.entry}`);
  } catch (error) {
    console.error("❌ runCheck failed:", error.message);
  }
}

async function showLivePrice(chatId) {
  try {
    const price = await fetchGoldPrice();

    await bot.sendMessage(
      chatId,
      `🤖 <b>BOT.XAU LIVE PRICE</b> 🥇\n\n💰 <b>XAU/USD:</b> ${money(price)}\n⏱️ ${new Date().toISOString()}\n📡 Twelve Data`,
      { parse_mode: "HTML", ...KEYBOARD }
    );
  } catch (error) {
    await bot.sendMessage(
      chatId,
      `⚠️ Could not fetch gold price: ${escapeHtml(error.message)}`,
      { parse_mode: "HTML", ...KEYBOARD }
    );
  }
}

async function showSignal(chatId) {
  if (!db.lastSignal) {
    await bot.sendMessage(
      chatId,
      "🤖 <b>BOT.XAU SNIPER ENTRY</b> 🥇\n\n🔎 No confirmed setup has been recorded yet. The bot checks closed M5 candles automatically.",
      { parse_mode: "HTML", ...KEYBOARD }
    );
    return;
  }

  const trade = db.open.find(t => t.setupId === db.lastSignal.setupId);
  const sentAt = db.lastSignal.sentAt
    ? new Date(db.lastSignal.sentAt).toISOString()
    : "Unknown";

  await bot.sendMessage(
    chatId,
    formatSignal(
      db.lastSignal,
      trade ? trade.status : "SIGNAL RECORDED"
    ) + `\n\n🕒 <b>Signal sent:</b> ${escapeHtml(sentAt)}`,
    { parse_mode: "HTML", ...KEYBOARD }
  );
}

async function showStatus(chatId) {
  const pending = db.open.filter(t => t.status === "PENDING").length;
  const active = db.open.filter(t => t.status === "ACTIVE").length;
  const last = db.lastSignal
    ? `${db.lastSignal.side} @ ${money(db.lastSignal.entry)}`
    : "No signal yet";

  await bot.sendMessage(
    chatId,
    [
      "🤖 <b>BOT.XAU STATUS</b> 🥇",
      "",
      "📡 <b>Market:</b> XAU/USD",
      "⏱️ <b>Timeframe:</b> M5 only",
      "🧠 <b>Strategy:</b> Liquidity sweep + MSS + 50% candle",
      `🕯️ <b>Last closed candle:</b> ${escapeHtml(db.lastEvaluated || "Waiting")}`,
      `📍 <b>Latest signal:</b> ${escapeHtml(last)}`,
      `⌛ <b>Pending limit setups:</b> ${pending}`,
      `✅ <b>Active simulated trades:</b> ${active}`,
      "",
      "🔔 Automatic checks are enabled while the service is running."
    ].join("\n"),
    { parse_mode: "HTML", ...KEYBOARD }
  );
}

async function showStats(chatId) {
  const trades = db.trades || [];
  const wins = trades.filter(t => t.status === "TP").length;
  const losses = trades.filter(t => t.status === "SL").length;
  const expired = trades.filter(t => t.status === "EXPIRED").length;
  const totalR = trades.reduce((sum, t) => sum + (Number(t.rResult) || 0), 0);

  await bot.sendMessage(
    chatId,
    [
      "🤖 <b>BOT.XAU STATS</b> 📊",
      "",
      `🧾 <b>Closed simulated trades:</b> ${trades.length}`,
      `🎯 <b>TP:</b> ${wins}`,
      `🛑 <b>SL:</b> ${losses}`,
      `⌛ <b>Expired setups:</b> ${expired}`,
      `⚖️ <b>Net R:</b> ${totalR >= 0 ? "+" : ""}${money(totalR)}R`,
      `📍 <b>Currently open:</b> ${db.open.length}`,
      "",
      "ℹ️ These are simulated results, not verified broker fills."
    ].join("\n"),
    { parse_mode: "HTML", ...KEYBOARD }
  );
}

bot.on("polling_error", error => {
  console.error("⚠️ Telegram polling error:", error.message);
});

bot.on("message", async message => {
  if (!message.chat || !message.chat.id || !message.text) return;

  const chatId = String(message.chat.id);
  const text = message.text.trim();

  if (!db.chats.includes(chatId)) {
    db.chats.push(chatId);
    saveDB();
  }

  try {
    if (text === "/start") {
      await bot.sendMessage(
        chatId,
        [
          "🤖 <b>WELCOME TO BOT.XAU SNIPER ENTRY</b> 🥇",
          "",
          "🔥 Automatic XAU/USD sniper setup monitoring.",
          "⏱️ Strategy timeframe: M5",
          "",
          "💧 Liquidity sweep",
          "🔀 Market Structure Shift (MSS)",
          "🕯️ Last opposing candle",
          "🎯 50% limit entry",
          "🛑 Stop loss beyond the candle",
          "💰 Target at opposing-side liquidity",
          "",
          "📊 Trade tracking is simulated. No broker orders are placed.",
          "",
          "👇 Use the buttons below."
        ].join("\n"),
        { parse_mode: "HTML", ...KEYBOARD }
      );
    } else if (text === "💰 Live Price") {
      await showLivePrice(chatId);
    } else if (text === "📈 XAUUSD Signal") {
      await showSignal(chatId);
    } else if (text === "🩺 Signal Status") {
      await showStatus(chatId);
    } else if (text === "📊 Stats") {
      await showStats(chatId);
    } else if (text === "/health") {
      await bot.sendMessage(chatId, "✅ BOT.XAU is running.", KEYBOARD);
    }
  } catch (error) {
    console.error("⚠️ Message handler error:", error.message);
  }
});

app.get("/", (req, res) => {
  res.send("🤖 BOT.XAU Sniper Entry is running.");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    bot: "BOT.XAU Sniper Entry",
    market: "XAU/USD",
    timeframe: "M5",
    open: db.open.length,
    closedTrades: db.trades.length,
    lastEvaluated: db.lastEvaluated
  });
});

app.post("/backtest-download", (req, res) => {
  const secret = process.env.BACKTEST_SECRET;

  if (!secret) {
    return res.status(503).json({ error: "BACKTEST_SECRET is not configured" });
  }

  const supplied = String(req.headers["x-backtest-secret"] || "");
  const expectedBuffer = Buffer.from(secret);
  const suppliedBuffer = Buffer.from(supplied);

  if (
    expectedBuffer.length !== suppliedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.json({
    exportedAt: new Date().toISOString(),
    market: "XAU/USD",
    timeframe: "M5",
    trades: db.trades,
    open: db.open,
    lastSignal: db.lastSignal
  });
});

app.listen(PORT, () => {
  console.log(`🤖 BOT.XAU listening on port ${PORT}`);
});

// Check after the next M5 candle closes, then every five minutes.
async function scheduledCheck() {
  await runCheck();

  const now = Date.now();
  const nextBoundary = (Math.floor(now / 300000) + 1) * 300000;
  const delay = Math.max(1000, nextBoundary - now + 3000);

  setTimeout(scheduledCheck, delay);
}

setTimeout(scheduledCheck, 5000);

// Optional Render keepalive.
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(async () => {
    try {
      await fetch(process.env.RENDER_EXTERNAL_URL);
    } catch (error) {
      console.log("ℹ️ Keepalive:", error.message);
    }
  }, 10 * 60 * 1000);
}
