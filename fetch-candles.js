
"use strict";

const fs = require("fs");

async function main() {
  const apiKey = process.env.TWELVE_DATA_KEY;

  if (!apiKey) {
    throw new Error(
      "TWELVE_DATA_KEY is missing from the environment."
    );
  }

  const url = new URL(
    "https://api.twelvedata.com/time_series"
  );

  url.searchParams.set("symbol", "XAU/USD");
  url.searchParams.set("interval", "15min");
  url.searchParams.set("outputsize", "5000");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", apiKey);

  console.log("Fetching historical XAUUSD candles...");

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || !Array.isArray(data.values)) {
    throw new Error(
      data.message || "Could not retrieve historical candles."
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
    .filter(c =>
      c.time &&
      [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
      c.high >= Math.max(c.open, c.close, c.low) &&
      c.low <= Math.min(c.open, c.close, c.high)
    )
    .sort((a, b) =>
      new Date(a.time + "Z") - new Date(b.time + "Z")
    );

  // Remove the newest candle because it may still be forming.
  if (candles.length) candles.pop();

  if (candles.length < 150) {
    throw new Error(
      `Only ${candles.length} candles received. ` +
      "Check your API access and symbol."
    );
  }

  fs.writeFileSync(
    "./candles.json",
    JSON.stringify(candles, null, 2)
  );

  console.log(`Saved ${candles.length} candles to candles.json`);
  console.log(`First candle: ${candles[0].time}`);
  console.log(`Last candle: ${candles[candles.length - 1].time}`);
}

main().catch(error => {
  console.error("FETCH ERROR:", error.message);
  process.exitCode = 1;
});
