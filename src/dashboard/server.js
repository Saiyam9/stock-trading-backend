import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import cors from "cors";
import { config } from "../config/env.js";
import { watchlist } from "../config/stocks.js";
import {
  getBenchmarkData,
  getStockData,
  getLivePrices,
} from "../services/dataService.js";
import { evaluateStock } from "../strategies/swingStrategy.js";
import {
  getAllTrades,
  getOpenTrades,
  getPerformanceAnalytics,
  getEdgeMetrics,
} from "../services/tradeService.js";
import {
  calculateWeightedPositionSize,
  canTakeNewTrade,
  isDrawdownPaused,
} from "../services/riskService.js";
import { logger } from "../utils/logger.js";
import { isMarketHours } from "../utils/helpers.js";
import { runDailyScan, monitorTrades } from "../index.js";
import {
  calculateRSI,
  evaluateMarketRegime,
} from "../services/indicatorService.js";
import {
  runBacktest,
  runMonteCarloSimulation,
  runParameterSensitivity,
  runWalkForwardTest,
} from "../services/backtestService.js";
import { getHealthSnapshot } from "../services/healthService.js";
import {
  generateLoginUrl,
  generateSession,
  getKite,
  isKiteAvailable,
  validateSession,
} from "../services/kiteService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "*",
  })
);
app.use(express.json());

// System status + config
app.get("/api/status", (_req, res) => {
  const openTrades = getOpenTrades();
  const allTrades = getAllTrades();
  const closedTrades = allTrades.filter((t) => t.status === "closed");

  const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const wins = closedTrades.filter((t) => t.pnl > 0).length;
  const losses = closedTrades.filter((t) => t.pnl <= 0).length;

  res.json({
    mode: config.mode,
    capital: config.capital,
    perTradeCapital: config.perTradeCapital,
    maxTrades: config.maxTrades,
    stopLossPercent: config.stopLossPercent,
    targetPercent: config.targetPercent,
    maxHoldDays: config.maxHoldDays,
    marketOpen: isMarketHours(),
    openTradesCount: openTrades.length,
    totalTradesCount: allTrades.length,
    closedTradesCount: closedTrades.length,
    totalPnl,
    winRate:
      closedTrades.length > 0
        ? ((wins / closedTrades.length) * 100).toFixed(1)
        : "N/A",
    wins,
    losses,
    canTrade: canTakeNewTrade(),
    automationMode: config.automationMode,
    killSwitch: config.killSwitch,
    drawdownState: isDrawdownPaused(),
    watchlistSize: watchlist.length,
    uptime: process.uptime(),
  });
});

app.get("/", (req, res) => {
  res.send("Stock Trading Backend API is running");
});

// All trades (open + closed)
app.get("/api/trades", (_req, res) => {
  const trades = getAllTrades();
  res.json(trades.reverse());
});

// Open trades with live prices when Kite is available
app.get("/api/trades/open", async (_req, res) => {
  const openTrades = getOpenTrades();
  if (openTrades.length === 0 || !config.kiteEnabled) {
    return res.json(openTrades);
  }

  try {
    const symbols = [...new Set(openTrades.map((t) => t.symbol))];
    const liveQuotes = await getLivePrices(symbols);

    const enriched = openTrades.map((trade) => {
      const livePrice = liveQuotes[trade.symbol]?.price ?? null;
      if (!livePrice) return trade;
      const isShort = trade.direction === "short";
      const unrealizedPnl = isShort
        ? (trade.entryPrice - livePrice) * trade.qty
        : (livePrice - trade.entryPrice) * trade.qty;
      return {
        ...trade,
        currentPrice: livePrice,
        priceSource: "LIVE",
        unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
      };
    });
    res.json(enriched);
  } catch {
    res.json(openTrades);
  }
});

app.get("/api/watchlist", (_req, res) => {
  res.json(watchlist);
});

// Scan the watchlist and return signals (does NOT execute trades)
app.get("/api/signals", async (_req, res) => {
  try {
    const benchmarkData = await getBenchmarkData();
    const marketTrend = evaluateMarketRegime(benchmarkData);

    const liveQuotes = config.kiteEnabled ? await getLivePrices(watchlist) : {};

    if (config.kiteEnabled && isKiteAvailable() && isMarketHours()) {
      try {
        const k = getKite();
        if (k) {
          const niftyQuote = await k.getQuote(["NSE:NIFTY 50"]);
          if (niftyQuote["NSE:NIFTY 50"]) {
            marketTrend.liveNiftyPrice = niftyQuote["NSE:NIFTY 50"].last_price;
          }
        }
      } catch {
        /* Nifty live quote is best-effort */
      }
    }

    const signals = [];
    for (const symbol of watchlist) {
      const data = await getStockData(symbol);
      if (!data) {
        signals.push({ symbol, error: "No data" });
        continue;
      }

      const livePrice = liveQuotes[symbol]?.price ?? null;
      if (livePrice) {
        data.price = livePrice;
      }
      const priceSource = livePrice ? "LIVE" : "DAILY";

      const signal = evaluateStock(data, { marketTrend, benchmarkData });
      signals.push({
        symbol,
        price: data.price,
        priceSource,
        rsi: signal.rsi,
        nearSupport: signal.nearSupport,
        supportLevel: signal.supportLevel,
        resistanceLevel: signal.resistanceLevel,
        riskReward: signal.riskReward,
        reason: signal.reason,
        marketTrend: signal.marketTrend,
        atrPercent: signal.atrPercent,
        relativeStrength: signal.relativeStrength,
        volumeRatio: signal.volumeRatio,
        volumeSpike: signal.volumeSpike,
        shouldBuy: signal.shouldBuy,
        positionSize: calculateWeightedPositionSize(
          data.price,
          signal.supportLevel,
          signal
        ),
        stopLoss:
          Math.round(data.price * (1 - config.stopLossPercent) * 100) / 100,
        target: Math.round(data.price * (1 + config.targetPercent) * 100) / 100,
      });
    }
    res.json({ marketTrend, signals });
  } catch (err) {
    logger.error(`Signal scan error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/chart/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const days = Number(req.query.days) || 180;
    const data = await getStockData(symbol, { lookbackDays: days });
    if (!data) {
      res.status(404).json({ error: "No data available" });
      return;
    }

    let priceSource = "DAILY";
    if (config.kiteEnabled) {
      const liveQuotes = await getLivePrices([symbol]);
      const livePrice = liveQuotes[symbol]?.price ?? null;
      if (livePrice) {
        data.price = livePrice;
        data.closes[data.closes.length - 1] = livePrice;
        priceSource = "LIVE";
      }
    }

    const rsiSeries = calculateRSI(data.closes);
    const paddedRsi = data.closes.map((_value, index) => {
      const rsiIndex = index - 14;
      const rsiValue = rsiIndex >= 0 ? rsiSeries[rsiIndex] : null;
      return rsiValue == null ? null : Math.round(rsiValue * 100) / 100;
    });
    const benchmarkData = await getBenchmarkData();
    const signal = evaluateStock(data, {
      marketTrend: evaluateMarketRegime(benchmarkData),
      benchmarkData,
    });

    res.json({
      symbol,
      dates: data.dates,
      closes: data.closes,
      highs: data.highs,
      lows: data.lows,
      rsi: paddedRsi,
      latestSignal: signal,
      priceSource,
    });
  } catch (err) {
    logger.error(`Chart endpoint error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/prices/live", async (_req, res) => {
  try {
    const quotes = await getLivePrices(watchlist);
    const prices = {};
    for (const symbol of watchlist) {
      if (quotes[symbol]) {
        prices[symbol] = {
          ...quotes[symbol],
          source:
            quotes[symbol].source ||
            (quotes[symbol].timestamp ? "kite" : "yahoo_daily"),
        };
      }
    }
    res.json({
      prices,
      kiteAvailable: isKiteAvailable(),
      marketOpen: isMarketHours(),
    });
  } catch (err) {
    logger.error(`Live prices error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/backtest", async (req, res) => {
  try {
    const lookbackDays = Number(req.query.days) || 365;
    const result = await runBacktest({ lookbackDays });
    res.json(result);
  } catch (err) {
    logger.error(`Backtest error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/validation/sensitivity", async (req, res) => {
  try {
    const lookbackDays = Number(req.query.days) || 365;
    const result = await runParameterSensitivity({ lookbackDays });
    res.json(result);
  } catch (err) {
    logger.error(`Sensitivity validation error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/validation/walk-forward", async (req, res) => {
  try {
    const trainDays = Number(req.query.trainDays) || 1095;
    const testDays = Number(req.query.testDays) || 730;
    const result = await runWalkForwardTest({ trainDays, testDays });
    res.json(result);
  } catch (err) {
    logger.error(`Walk-forward validation error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/validation/monte-carlo", async (req, res) => {
  try {
    const lookbackDays = Number(req.query.days) || 365;
    const iterations = Number(req.query.iterations) || 500;
    const backtest = await runBacktest({ lookbackDays });
    const monteCarlo = runMonteCarloSimulation({
      trades: backtest.trades,
      iterations,
    });
    res.json({ backtestSummary: backtest.summary, monteCarlo });
  } catch (err) {
    logger.error(`Monte Carlo validation error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/analytics", (_req, res) => {
  res.json(getPerformanceAnalytics());
});

app.get("/api/attribution", async (req, res) => {
  try {
    const lookbackDays = Number(req.query.days) || 365;
    const result = await runBacktest({ lookbackDays });
    res.json({
      summary: result.summary,
      attribution: result.attribution,
      tradeCount: result.trades.length,
    });
  } catch (err) {
    logger.error(`Attribution error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (_req, res) => {
  res.json(getHealthSnapshot());
});

app.get("/api/edge", (req, res) => {
  const window = Number(req.query.window) || config.edgeRollingWindow;
  res.json(getEdgeMetrics(window));
});

app.get("/api/trades/:id/journal", (req, res) => {
  const allTrades = getAllTrades();
  const trade = allTrades.find((t) => t.id === req.params.id);
  if (!trade) return res.status(404).json({ error: "Trade not found" });
  res.json({
    id: trade.id,
    symbol: trade.symbol,
    status: trade.status,
    journal: trade.journal ?? [],
    trailingHistory: trade.trailingHistory ?? [],
  });
});

// Trigger a manual daily scan
app.post("/api/scan", async (_req, res) => {
  try {
    await runDailyScan();
    res.json({ success: true, message: "Daily scan completed" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trigger manual trade monitoring
app.post("/api/monitor", async (_req, res) => {
  try {
    await monitorTrades();
    res.json({ success: true, message: "Trade monitoring completed" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Recent logs
app.get("/api/logs", (_req, res) => {
  const logFile = path.resolve(__dirname, "../../logs/trading.log");
  try {
    const content = fs.readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n");
    res.json(lines.slice(-100).reverse());
  } catch {
    res.json([]);
  }
});

app.get("/api/kite/status", async (_req, res) => {
  if (!config.kiteEnabled) {
    return res.json({
      enabled: false,
      configured: false,
      sessionValid: false,
      available: false,
    });
  }
  const sessionValid = await validateSession();
  res.json({
    enabled: true,
    configured: !!config.apiKey,
    hasAccessToken: !!config.accessToken,
    sessionValid,
    available: isKiteAvailable(),
  });
});

app.get("/api/kite/login", async (_req, res) => {
  if (!config.kiteEnabled) {
    return res
      .status(400)
      .json({ error: "Kite is not enabled (set KITE_ENABLED=true)" });
  }
  const url = await generateLoginUrl();
  if (url) {
    res.json({ loginUrl: url });
  } else {
    res.status(400).json({ error: "Kite API key not configured" });
  }
});

app.post("/api/kite/session", async (req, res) => {
  if (!config.kiteEnabled) {
    return res
      .status(400)
      .json({ error: "Kite is not enabled (set KITE_ENABLED=true)" });
  }
  const { request_token } = req.body;
  if (!request_token) {
    return res.status(400).json({ error: "request_token is required" });
  }
  const session = await generateSession(request_token);
  if (session) {
    res.json({
      success: true,
      userId: session.user_id,
      accessToken: session.access_token,
      loginTime: session.login_time,
    });
  } else {
    res.status(401).json({ error: "Failed to generate session" });
  }
});

const server = app.listen(PORT);
server.on("listening", async () => {
  logger.info(`Dashboard running at http://localhost:${PORT}`);
  if (config.kiteEnabled) {
    const valid = await validateSession();
    logger.info(
      `Kite session on dashboard startup: ${valid ? "VALID" : "INVALID"}`
    );
  }
});
