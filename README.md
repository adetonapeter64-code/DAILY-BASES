XAUUSD STRICT SNIPER UPDATE

Files:
- server.js
- strategy.js

Strategy:
- M15 EMA trend filter
- M5 liquidity sweep, structure break/displacement, FVG
- M1 FVG retest and candle confirmation
- 1:3 target, 3 signals/day maximum, 30-minute cooldown
- Signal tracker only; does not place broker orders.

Deploy:
1. Back up the current server.js and strategy.js from GitHub.
2. Replace both files in the same repository with these versions.
3. Keep package.json and existing environment variables.
4. Confirm TELEGRAM_BOT_TOKEN and TWELVE_DATA_KEY are set in Render.
5. Commit changes to GitHub and wait for Render deployment.
6. Open the Render service /health endpoint and check ok, lastCheck, and last M1 candle.
7. In Telegram, send /start and use Signal Status.
8. Run in simulation first. Strategy is rule-based and has not been proven profitable; verify Twelve Data access/limits and test historical performance before any live trading.

Note: This version uses Twelve Data for 1min, 5min, and 15min XAU/USD candles. API plan limits may affect availability. Render's local filesystem may reset on redeploy unless persistent storage is configured, so simulated trade history may not persist.
