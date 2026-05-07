import cron from 'node-cron';
import { config } from './config/env.js';
import { symbolSectorMap, watchlist } from './config/stocks.js';
import { getBenchmarkData, getStockData, getLivePrices } from './services/dataService.js';
import { evaluateStock } from './strategies/swingStrategy.js';
import {
  calculateWeightedPositionSize,
  canTakeNewTrade,
  checkDailyLossCircuitBreaker,
  exceedsSectorExposure,
  exceedsSectorCapitalExposure,
  isDrawdownPaused,
} from './services/riskService.js';
import {
  calculateATR,
  calculateCorrelation,
  evaluateMarketRegime,
} from './services/indicatorService.js';
import { placeTrade, exitTrade } from './services/executionService.js';
import { getOpenTrades, updateTradeStopLoss, addJournalEntry, getEdgeMetrics } from './services/tradeService.js';
import { sendAlert } from './services/alertService.js';
import { logger } from './utils/logger.js';
import { daysBetween, isAfterISTTime, isMarketHours } from './utils/helpers.js';
import { recordApiFailure } from './services/healthService.js';
import { validateSession, isKiteAvailable } from './services/kiteService.js';
import { fileURLToPath } from 'url';
import path from 'path';

export async function runDailyScan() {
  logger.info(`=== Daily Scan Started [${config.mode.toUpperCase()} MODE] ===`);
  logger.info(`Watchlist: ${watchlist.join(', ')}`);
  if (config.killSwitch) {
    logger.warn('Global kill switch is ON (STOP_ALL=true). Skipping scan.');
    return;
  }
  if (!isAfterISTTime(config.entryStartHourIST, config.entryStartMinuteIST)) {
    logger.info(
      `Entry window guard active. Skipping entries before ${String(config.entryStartHourIST).padStart(2, '0')}:${String(config.entryStartMinuteIST).padStart(2, '0')} IST`
    );
    return;
  }
  const drawdownState = isDrawdownPaused();
  if (drawdownState.paused) {
    logger.warn(`Trading paused due to drawdown until ${drawdownState.pauseUntil}`);
    return;
  }
  const edge = getEdgeMetrics(config.edgeRollingWindow);
  if (edge.sampleSize >= config.edgeRollingWindow && edge.shouldDisable) {
    logger.warn(
      `Edge auto-disable: expectancy ${edge.rollingExpectancy} < 0 AND win rate falling AND drawdown worsening over last ${edge.sampleSize} trades. Skipping scan.`
    );
    await sendAlert(`🛑 Strategy auto-disabled: expectancy=${edge.rollingExpectancy}, winRate=${edge.rollingWinRate}%, drawdown=${edge.rollingDrawdownTrend}`);
    return;
  }

  const benchmarkData = await getBenchmarkData();
  const marketTrend = evaluateMarketRegime(benchmarkData);
  logger.info(
    `Market Regime | Nifty: ${marketTrend.latestClose ?? '--'} | 50-SMA: ${marketTrend.sma50 ?? '--'} | 200-SMA: ${marketTrend.sma200 ?? '--'} | Trend: ${marketTrend.trendLabel}`
  );

  const liveQuotes = config.kiteEnabled ? await getLivePrices(watchlist) : {};
  const currentPrices = {};
  let signalsFound = 0;
  let tradesPlaced = 0;

  for (const symbol of watchlist) {
    try {
      const data = await getStockData(symbol);
      if (!data) continue;

      const livePrice = liveQuotes[symbol]?.price ?? null;
      if (livePrice) {
        data.price = livePrice;
      }
      const priceSource = livePrice ? 'LIVE' : 'DAILY';

      currentPrices[symbol] = data.price;
      const signal = evaluateStock(data, { marketTrend, benchmarkData });

      logger.info(
        `${symbol} [${priceSource}] | Price: ₹${data.price} | RSI: ${signal.rsi} | ATR%: ${signal.atrPercent} | VolRatio: ${signal.volumeRatio} | RS20: ${signal.relativeStrength} | RR: ${signal.riskReward} | Buy: ${signal.shouldBuy} | Reason: ${signal.reason}`
      );

      if (!signal.shouldBuy) continue;
      signalsFound++;

      if (!canTakeNewTrade()) continue;
      if (checkDailyLossCircuitBreaker(currentPrices)) continue;
      if (exceedsSectorExposure(symbol)) continue;

      const qty = calculateWeightedPositionSize(data.price, signal.supportLevel, signal, data);
      if (qty <= 0) {
        logger.warn(`${symbol}: Position size is 0, skipping`);
        continue;
      }
      const candidateCapital = qty * data.price;
      if (exceedsSectorCapitalExposure(symbol, candidateCapital)) continue;

      const openTrades = getOpenTrades();
      let isHighlyCorrelated = false;
      for (const openTrade of openTrades) {
        const peerData = await getStockData(openTrade.symbol, { lookbackDays: 120 });
        if (!peerData) continue;
        const corr = calculateCorrelation(data.closes, peerData.closes, 60);
        if (corr != null && corr >= config.maxCorrelation) {
          logger.info(
            `${symbol}: blocked due to high correlation ${corr.toFixed(2)} with ${openTrade.symbol}`
          );
          isHighlyCorrelated = true;
          break;
        }
      }
      if (isHighlyCorrelated) continue;

      if (config.automationMode === 'semi-auto') {
        await sendAlert(
          `🟡 APPROVAL NEEDED (${config.mode.toUpperCase()})\n${symbol}\nSector: ${symbolSectorMap[symbol] || 'UNKNOWN'}\nPrice: ₹${data.price}\nRSI: ${signal.rsi}\nATR%: ${signal.atrPercent}\nRR: ${signal.riskReward}\nQty: ${qty}`
        );
        continue;
      }

      await placeTrade(symbol, qty, data.price, {
        direction: signal.direction ?? 'long',
        atr: signal.atr,
        signalTag: {
          strategy: signal.strategy,
          direction: signal.direction ?? 'long',
          reason: signal.reason,
          rsi: signal.rsi,
          riskReward: signal.riskReward,
          atrPercent: signal.atrPercent,
          relativeStrength: signal.relativeStrength,
          volumeRatio: signal.volumeRatio,
        },
        marketCondition: {
          trendLabel: marketTrend.trendLabel,
          regime: marketTrend.regime,
          niftyClose: marketTrend.latestClose,
        },
      });
      tradesPlaced++;
    } catch (err) {
      logger.error(`Error processing ${symbol}: ${err.message}`);
      recordApiFailure(`scan_${symbol}: ${err.message}`);
    }
  }

  const summary = `=== Scan Complete | Signals: ${signalsFound} | Trades: ${tradesPlaced} ===`;
  logger.info(summary);
  await sendAlert(`📋 Daily Scan Summary\nSignals: ${signalsFound}\nTrades Placed: ${tradesPlaced}`);
}

export async function monitorTrades() {
  if (config.killSwitch) {
    logger.warn('Global kill switch is ON (STOP_ALL=true). Skipping monitor cycle.');
    return;
  }
  const openTrades = getOpenTrades();
  if (openTrades.length === 0) return;

  logger.info(`Monitoring ${openTrades.length} open trade(s)...`);

  const tradeSymbols = [...new Set(openTrades.map((t) => t.symbol))];
  const liveQuotes = config.kiteEnabled ? await getLivePrices(tradeSymbols) : {};

  for (const trade of openTrades) {
    try {
      let currentPrice;
      if (config.kiteEnabled) {
        currentPrice = liveQuotes[trade.symbol]?.price ?? null;
        if (!currentPrice) {
          logger.warn(`${trade.symbol}: No live price available, skipping monitor cycle`);
          continue;
        }
      } else {
        const data = await getStockData(trade.symbol);
        if (!data) continue;
        currentPrice = data.price;
      }
      const daysHeld = daysBetween(trade.entryDate, new Date());
      const isShort = trade.direction === 'short';
      let exitReason = null;

      if (isShort) {
        if (currentPrice <= trade.target) {
          exitReason = 'target_hit';
        } else if (currentPrice >= trade.stopLoss) {
          exitReason = 'stop_loss';
        } else if (daysHeld >= config.maxHoldDays) {
          exitReason = 'time_exit';
        }
      } else {
        if (currentPrice >= trade.target) {
          exitReason = 'target_hit';
        } else if (currentPrice <= trade.stopLoss) {
          exitReason = 'stop_loss';
        } else if (daysHeld >= config.maxHoldDays) {
          exitReason = 'time_exit';
        }
      }

      if (exitReason) {
        logger.info(`${trade.symbol}: ${exitReason} at ₹${currentPrice}`);
        await exitTrade(trade, currentPrice, exitReason);
        addJournalEntry(trade.id, {
          event: 'exit',
          reason: exitReason,
          price: currentPrice,
          daysHeld,
          pnlPercent: ((currentPrice - trade.entryPrice) / trade.entryPrice * 100).toFixed(2),
        });
        continue;
      }

      if (config.trailingStopEnabled && daysHeld >= config.trailingStopMinDays) {
        const data = await getStockData(trade.symbol);
        if (!data) continue;

        const riskPerShare = isShort
          ? trade.stopLoss - trade.entryPrice
          : trade.entryPrice - trade.stopLoss;
        const unrealizedR = riskPerShare > 0
          ? (isShort
            ? (trade.entryPrice - currentPrice) / riskPerShare
            : (currentPrice - trade.entryPrice) / riskPerShare)
          : 0;

        if (unrealizedR >= config.trailingStopActivationR) {
          const atrValues = calculateATR(data.highs, data.lows, data.closes, config.atrPeriod);
          const latestAtr = atrValues[atrValues.length - 1] ?? riskPerShare;
          let newStop;

          if (isShort) {
            const atrTrailStop = Math.round((currentPrice + latestAtr * config.trailingStopAtrMultiplier) * 100) / 100;
            newStop = Math.min(trade.stopLoss, atrTrailStop);
            if (unrealizedR >= config.trailingStopBreakevenR) {
              newStop = Math.min(newStop, trade.entryPrice);
            }
          } else {
            const atrTrailStop = Math.round((currentPrice - latestAtr * config.trailingStopAtrMultiplier) * 100) / 100;
            newStop = Math.max(trade.stopLoss, atrTrailStop);
            if (unrealizedR >= config.trailingStopBreakevenR) {
              newStop = Math.max(newStop, trade.entryPrice);
            }
          }

          const improved = isShort ? newStop < trade.stopLoss : newStop > trade.stopLoss;
          if (improved) {
            logger.info(
              `${trade.symbol}: Trailing SL ${isShort ? 'lowered' : 'raised'} ₹${trade.stopLoss} -> ₹${newStop} (R=${unrealizedR.toFixed(1)})`
            );
            updateTradeStopLoss(trade.id, newStop);
            addJournalEntry(trade.id, {
              event: 'trailing_stop_update',
              oldStop: trade.stopLoss,
              newStop,
              unrealizedR: unrealizedR.toFixed(2),
            });
            trade.stopLoss = newStop;
          }
        }
      }

      const pnlPercent = isShort
        ? ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100
        : ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
      logger.info(
        `${trade.symbol}: Holding ${isShort ? 'SHORT' : 'LONG'} | Price: ₹${currentPrice} | PnL: ${pnlPercent.toFixed(2)}% | Days: ${daysHeld} | SL: ₹${trade.stopLoss}`
      );
    } catch (err) {
      logger.error(`Error monitoring ${trade.symbol}: ${err.message}`);
      recordApiFailure(`monitor_${trade.symbol}: ${err.message}`);
    }
  }
}

async function startupChecks() {
  logger.info('--- Running startup checks ---');

  logger.info(`Mode: ${config.mode.toUpperCase()}`);
  logger.info(`Capital: ₹${config.capital.toLocaleString('en-IN')} | Per Trade: ₹${config.perTradeCapital.toLocaleString('en-IN')}`);
  logger.info(`Max Trades: ${config.maxTrades} | Short System: ${config.shortSystemEnabled ? 'ENABLED' : 'DISABLED'}`);
  logger.info(`Watchlist: ${watchlist.length} stocks (${watchlist.join(', ')})`);

  if (config.kiteEnabled) {
    logger.info('Kite Connect: ENABLED');
    if (config.apiKey && config.accessToken) {
      const valid = await validateSession();
      if (valid) {
        logger.info('Kite Connect: session VALID');
      } else {
        logger.warn('Kite Connect: session INVALID — will fall back to Yahoo daily data');
        if (config.mode === 'live') {
          logger.error('CRITICAL: Live mode requires valid Kite session. Fix ACCESS_TOKEN and restart.');
          await sendAlert('🚨 CRITICAL: Bot started in LIVE mode but Kite session is invalid. No orders will be placed.');
        }
      }
    } else {
      logger.warn('Kite Connect: ENABLED but API_KEY/ACCESS_TOKEN not set');
    }
  } else {
    logger.info('Kite Connect: DISABLED — using Yahoo Finance daily data only');
  }

  const openTrades = getOpenTrades();
  if (openTrades.length > 0) {
    logger.info(`Open trades found: ${openTrades.length}`);
    for (const t of openTrades) {
      const daysHeld = daysBetween(t.entryDate, new Date());
      logger.info(`  ${t.symbol} ${t.direction?.toUpperCase() || 'LONG'} | Entry: ₹${t.entryPrice} | SL: ₹${t.stopLoss} | Target: ₹${t.target} | Days: ${daysHeld}`);
    }
  } else {
    logger.info('No open trades');
  }

  const edge = getEdgeMetrics(config.edgeRollingWindow);
  if (edge.sampleSize > 0) {
    logger.info(`Edge metrics (last ${edge.sampleSize} trades): WinRate=${edge.rollingWinRate}% | Expectancy=${edge.rollingExpectancy} | Drawdown=${edge.rollingDrawdownTrend}`);
    if (edge.shouldDisable) {
      logger.warn('Edge auto-disable is ACTIVE — trading will be paused until edge recovers');
    }
  }

  const drawdownState = isDrawdownPaused();
  if (drawdownState.paused) {
    logger.warn(`Drawdown pause ACTIVE until ${drawdownState.pauseUntil} (max DD: ${drawdownState.maxDrawdownPercent}%)`);
  }

  logger.info('--- Startup checks complete ---');
}

function setupGracefulShutdown() {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`Received ${signal}. Shutting down gracefully...`);

    const openTrades = getOpenTrades();
    if (openTrades.length > 0) {
      const msg = `⚠️ Bot shutting down with ${openTrades.length} open trade(s):\n${openTrades.map((t) => `${t.symbol} ${t.direction?.toUpperCase() || 'LONG'} @ ₹${t.entryPrice}`).join('\n')}`;
      logger.warn(msg);
      await sendAlert(msg);
    }

    await sendAlert(`🔴 Trading Bot stopped (${signal})`);
    logger.info('Shutdown complete.');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', async (err) => {
    logger.error(`Uncaught exception: ${err.message}\n${err.stack}`);
    recordApiFailure(`uncaught: ${err.message}`);
    await sendAlert(`🚨 UNCAUGHT ERROR: ${err.message}`);
  });
  process.on('unhandledRejection', async (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error(`Unhandled rejection: ${msg}`);
    recordApiFailure(`unhandled_rejection: ${msg}`);
    await sendAlert(`🚨 UNHANDLED REJECTION: ${msg}`);
  });
}

const __filename = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMainModule) {
  setupGracefulShutdown();
  await startupChecks();

  cron.schedule('20 9 * * 1-5', () => {
    runDailyScan().catch((err) => {
      logger.error(`Daily scan failed: ${err.message}`);
      sendAlert(`🚨 Daily scan FAILED: ${err.message}`);
    });
  }, { timezone: 'Asia/Kolkata' });

  cron.schedule('*/5 9-15 * * 1-5', () => {
    monitorTrades().catch((err) => {
      logger.error(`Trade monitor failed: ${err.message}`);
      sendAlert(`🚨 Monitor FAILED: ${err.message}`);
    });
  }, { timezone: 'Asia/Kolkata' });

  logger.info('Cron jobs scheduled. Waiting for market hours...');
  const kiteStatus = config.kiteEnabled
    ? (isKiteAvailable() ? 'CONNECTED' : 'ENABLED (session invalid)')
    : 'DISABLED (Yahoo only)';
  await sendAlert(
    `🤖 Trading Bot Started\nMode: ${config.mode.toUpperCase()}\nKite: ${kiteStatus}\nWatchlist: ${watchlist.length} stocks\nOpen Trades: ${getOpenTrades().length}`
  );
}
