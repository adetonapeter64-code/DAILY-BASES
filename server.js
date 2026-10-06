// Money Making Machine - XAUUSD signal bot (RSI Pullback + EMA trend, 15M)
// Env vars: TELEGRAM_BOT_TOKEN, TWELVE_DATA_KEY, optional TELEGRAM_CHAT_ID, RENDER_EXTERNAL_URL
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const { CFG, evaluateAt, precompute } = require("./strategy");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TD_KEY = process.env.TWELVE_DATA_KEY;
const PORT = process.env.PORT || 3000;
const DATA_FILE = "./data.json";
const TF_MS = 15 * 60 * 1000;

if (!TOKEN || !TD_KEY) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TWELVE_DATA_KEY environment variable.");
  process.exit(1);
}

// ---------- storage (best effort; Render free disk resets on redeploy) ----------
let db = { chats: [], state: { lastSignalMs: 0, countByDay: {} }, open: null, trades: [], lastSignal: null, lastEvaluated: "" };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) }; } catch (e) {}
if (process.env.TELEGRAM_CHAT_ID && !db.chats.includes(process.env.TELEGRAM_CHAT_ID)) db.chats.push(process.env.TELEGRAM_CHAT_ID);
const save = () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) {} };

const status = { lastCheck: null, lastCandle: null, error: null, nextCheck: null };

// ---------- helpers ----------
const toMs = (t) => Date.parse(t.replace(" ", "T") + "Z");
const f2 = (n) => Number(n).toFixed(2);
const bot = new TelegramBot(TOKEN, { polling: true });
const KB = {
  reply_markup: {
    keyboard: [["💰 Live Price", "📈 XAUUSD Signal"], ["🩺 Signal Status", "📊 Stats"]],
    resize_keyboard: true,
  },
};
async function notify(text) {
  for (const id of db.chats) {
    try { await bot.sendMessage(id, text, KB); } catch (e) { console.error("send fail", id, e.message); }
  }
}

// ---------- Twelve Data ----------
async function fetchCandles() {
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=15min&outputsize=300&timezone=UTC&apikey=${TD_KEY}`;
  const j = await (await fetch(url)).json();
  if (!j.values) throw new Error(j.message || "No data from Twelve Data");
  const now = Date.now();
  return j.values
    .reverse()
    .map((v) => ({ time: v.datetime, open: +v.open, high: +v.high, low: +v.low, close: +v.close }))
    .filter((c) => toMs(c.time) + TF_MS <= now + 5000); // closed candles only
}

let priceCache = { t: 0, p: null };
async function fetchPrice() {
  if (Date.now() - priceCache.t < 20000 && priceCache.p) return priceCache.p;
  const j = await (await fetch(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${TD_KEY}`)).json();
  if (!j.price) throw new Error(j.message || "Price unavailable");
  priceCache = { t: Date.now(), p: Number(j.price) };
  return priceCache.p;
}

// ---------- trade tracking (demo log) ----------
function finishTrade(o, r, why, closedTime, exit) {
  db.trades.push({ ...o, r, why, closed: closedTime });
  db.open = null;
  const t = db.trades;
  const wins = t.filter((x) => x.r > 0).length;
  const net = t.reduce((a, x) => a + x.r, 0);
  notify(
    `${r > 0 ? "✅🎉" : r < 0 ? "❌😔" : "⚪"} TRADE CLOSED: ${why}\n` +
    `🥇 XAUUSD ${o.side}\n📍 Entry: ${f2(o.entry)}\n🏁 Exit: ${f2(exit)}\n` +
    `💵 Result: ${r > 0 ? "+" : ""}${r}R\n\n` +
    `📊 Total: ${t.length} trades | Win rate ${Math.round((wins / t.length) * 100)}% | Net ${net.toFixed(2)}R`
  );
  save();
}

function resolveOpen(candles) {
  const o = db.open;
  if (!o) return;
  for (const c of candles) {
    if (toMs(c.time) <= toMs(o.time)) continue;
    const hitSL = o.side === "BUY" ? c.low <= o.sl : c.high >= o.sl;
    const hitTP = o.side === "BUY" ? c.high >= o.tp : c.low <= o.tp;
    let r = null, why = "";
    if (hitSL) { r = -1; why = "STOP LOSS"; }
    else if (hitTP) { r = CFG.rr; why = "TAKE PROFIT"; }
    else if (toMs(c.time) - toMs(o.time) > 24 * 3600 * 1000) {
      const dir = o.side === "BUY" ? 1 : -1;
      r = Math.round(((c.close - o.entry) * dir / Math.abs(o.entry - o.sl)) * 100) / 100;
      why = "EXPIRED (24h)";
    }
    if (r !== null) {
      const exit = hitSL ? o.sl : hitTP ? o.tp : c.close;
      finishTrade(o, r, why, c.time, exit);
      return;
    }
  }
}

async function runCheck() {
  try {
    const candles = await fetchCandles();
    if (candles.length < 120) throw new Error("Not enough candle data yet");
    const last = candles[candles.length - 1];
    status.lastCheck = new Date().toISOString();
    status.lastCandle = last.time;
    status.error = null;

    resolveOpen(candles);

    if (!db.open && db.lastEvaluated !== last.time) {
      db.lastEvaluated = last.time;
      const s = evaluateAt(candles, candles.length - 1, db.state, CFG, precompute(candles));
      if (s) {
        db.state.lastSignalMs = toMs(s.time);
        const day = s.time.slice(0, 10);
        db.state.countByDay[day] = (db.state.countByDay[day] || 0) + 1;
        db.open = s;
        db.lastSignal = s;
        notify(
          `🔔 NEW SIGNAL ${s.side === "BUY" ? "🟢📈" : "🔴📉"}\n` +
          `🥇 XAUUSD ${s.side} (15M)\n📍 Entry: ${f2(s.entry)}\n🛑 Stop Loss: ${f2(s.sl)}\n🎯 Take Profit: ${f2(s.tp)}\n` +
          `⚖️ RR 1:${CFG.rr} | RSI ${s.rsi} | ATR ${s.atr}\n🕒 Candle: ${s.time} UTC`
        );
      }
    }
    save();
  } catch (e) {
    status.error = e.message;
    status.lastCheck = new Date().toISOString();
    console.error("check failed:", e.message);
  }
}

// While a trade is open, check live price every 3 min and warn if it nears SL or TP
async function checkProximity() {
  const o = db.open;
  if (!o) return;
  try {
    const p = await fetchPrice();
    const dir = o.side === "BUY" ? 1 : -1;
    const toSL = ((o.entry - p) * dir) / Math.abs(o.entry - o.sl);   // 1 = at stop loss
    const toTP = ((p - o.entry) * dir) / Math.abs(o.tp - o.entry);   // 1 = at take profit
    if (toSL >= 1) return finishTrade(o, -1, "STOP LOSS", new Date().toISOString(), o.sl);
    if (toTP >= 1) return finishTrade(o, CFG.rr, "TAKE PROFIT", new Date().toISOString(), o.tp);
    if (toSL >= 0.7 && !o.warnSL) {
      o.warnSL = true;
      notify(
        `⚠️🚨 WARNING: ${o.side} signal is close to being dropped!\n` +
        `💰 Price now: ${f2(p)}\n🛑 Stop Loss: ${f2(o.sl)}\n📍 Entry: ${f2(o.entry)}\n` +
        `Consider protecting your trade 🛡️`
      );
    }
    if (toTP >= 0.8 && !o.warnTP) {
      o.warnTP = true;
      notify(`🎯🔥 ${o.side} is almost at Take Profit!\n💰 Price now: ${f2(p)}\n🎯 Target: ${f2(o.tp)}`);
    }
    save();
  } catch (e) {}
}
setInterval(checkProximity, 3 * 60 * 1000);

// check once, ~10s after each 15M candle closes (96 calls/day, fine for free tier)
let lastBoundary = 0;
setInterval(() => {
  const now = Date.now();
  const b = Math.floor(now / TF_MS);
  status.nextCheck = new Date((b + 1) * TF_MS + 10000).toISOString();
  if (b !== lastBoundary && now - b * TF_MS >= 10000) {
    lastBoundary = b;
    runCheck();
  }
}, 5000);
runCheck();

// ---------- Telegram handlers ----------
function statsText() {
  const t = db.trades;
  if (!t.length) return "📊 No closed trades yet ⏳";
  const wins = t.filter((x) => x.r > 0).length;
  const net = t.reduce((a, x) => a + x.r, 0);
  const lastFive = t.slice(-5).map((x) => `${x.side} ${x.r > 0 ? "+" : ""}${x.r}R`).join("\n");
  return `📊 Demo stats\nTrades: ${t.length}\nWin rate: ${Math.round((wins / t.length) * 100)}% (need >33% at 1:${CFG.rr})\nNet: ${net.toFixed(2)}R\n\nLast trades:\n${lastFive}`;
}

function signalText() {
  if (db.open) {
    const o = db.open;
    return `${o.side === "BUY" ? "🟢📈" : "🔴📉"} ACTIVE ${o.side} XAUUSD\n📍 Entry: ${f2(o.entry)}\n🛑 SL: ${f2(o.sl)}\n🎯 TP: ${f2(o.tp)}\n🕒 Opened: ${o.time} UTC`;
  }
  if (db.lastSignal) {
    const s = db.lastSignal;
    return `😴 No active signal right now.\n🕘 Last: ${s.side} at ${f2(s.entry)} (${s.time} UTC)`;
  }
  return "🔍 No signal yet. I check after every 15M candle closes ⏱️";
}

function statusText() {
  const h = new Date().getUTCHours();
  const inSession = h >= CFG.sessionStartUTC && h < CFG.sessionEndUTC;
  const today = new Date().toISOString().slice(0, 10);
  return (
    `🩺 Signal checking status\n` +
    `Data: ${status.error ? "❌ " + status.error : "✅ OK"}\n` +
    `Last check: ${status.lastCheck || "not yet"}\n` +
    `Last closed candle: ${status.lastCandle || "n/a"} UTC\n` +
    `Next check: ${status.nextCheck || "soon"}\n` +
    `Session (${CFG.sessionStartUTC}:00-${CFG.sessionEndUTC}:00 UTC): ${inSession ? "🟢 open" : "⚪ closed"}\n` +
    `Signals today: ${db.state.countByDay[today] || 0}/${CFG.maxPerDay}\n` +
    `Open trade: ${db.open ? db.open.side : "none"}`
  );
}

bot.on("message", async (msg) => {
  const id = String(msg.chat.id);
  const text = (msg.text || "").trim();
  if (!db.chats.includes(id)) { db.chats.push(id); save(); }
  try {
    if (text === "/start") {
      return bot.sendMessage(id, "🚀 Money Making Machine is running ✅\n📊 Strategy: RSI pullback + EMA trend (15M XAUUSD)\n📩 Signals will be sent to you automatically.\n⚠️ You will get a warning if a signal is close to its stop loss.", KB);
    }
    if (text === "💰 Live Price" || text === "/price") {
      const p = await fetchPrice();
      return bot.sendMessage(id, `💰 XAUUSD: ${f2(p)}`, KB);
    }
    if (text === "📈 XAUUSD Signal" || text === "/signal") return bot.sendMessage(id, signalText(), KB);
    if (text === "🩺 Signal Status" || text === "/status") return bot.sendMessage(id, statusText(), KB);
    if (text === "📊 Stats" || text === "/stats") return bot.sendMessage(id, statsText(), KB);
    return bot.sendMessage(id, "🤖 Please use the buttons below 👇\nI send signals to you automatically 📩", KB);
  } catch (e) {
    bot.sendMessage(id, "⚠️📡 Market data unavailable: " + e.message, KB);
  }
});
bot.on("polling_error", (e) => console.error("polling error:", e.message));

// ---------- web server + keep-alive for Render ----------
const app = express();
app.get("/", (req, res) => res.send("Money Making Machine is running"));
app.get("/health", (req, res) => res.json({ ok: true, ...status }));
app.listen(PORT, () => console.log("Listening on", PORT));
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => fetch(process.env.RENDER_EXTERNAL_URL + "/health").catch(() => {}), 10 * 60 * 1000);
}
