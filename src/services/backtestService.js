import { config } from '../config/env.js';
import { watchlist } from '../config/stocks.js';
import { getBenchmarkData, getStockData } from './dataService.js';
import { evaluateStock } from '../strategies/swingStrategy.js';
import { calculateATR, evaluateMarketRegime } from './indicatorService.js';
import { calculatePositionSize } from './riskService.js';

function round(value) {
  return Math.round(value * 100) / 100;
}

function computeTradeCost(entryPrice, exitPrice, qty) {
  const turnover = (entryPrice * qty) + (exitPrice * qty);
  return config.tradeCostFixed * 2 + turnover * config.tradeCostPercent;
}

function computeDrawdown(closedTrades) {
  let equity = config.capital;
  let peak = equity;
  let maxDrawdown = 0;

  const ordered = [...closedTrades].sort(
    (a, b) => new Date(a.exitDate) - new Date(b.exitDate)
  );

  for (const trade of ordered) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return round(maxDrawdown);
}

function summarizeTrades(closedTrades) {
  const totalTrades = closedTrades.length;
  const wins = closedTrades.filter((trade) => trade.pnl > 0).length;
  const losses = closedTrades.filter((trade) => trade.pnl <= 0).length;
  const winningTrades = closedTrades.filter((trade) => trade.pnl > 0);
  const losingTrades = closedTrades.filter((trade) => trade.pnl < 0);
  const grossProfit = winningTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((sum, trade) => sum + trade.pnl, 0));
  const totalPnl = closedTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
  const avgWin = winningTrades.length > 0 ? grossProfit / winningTrades.length : 0;
  const avgLoss = losingTrades.length > 0 ? grossLoss / losingTrades.length : 0;
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const lossRate = totalTrades > 0 ? losses / totalTrades : 0;
  const avgHoldDays = totalTrades > 0
    ? closedTrades.reduce((sum, trade) => sum + trade.daysHeld, 0) / totalTrades
    : 0;

  return {
    totalTrades,
    wins,
    losses,
    winRate: round(winRate * 100),
    totalPnl: round(totalPnl),
    avgPnl: round(avgPnl),
    avgWin: round(avgWin),
    avgLoss: round(avgLoss),
    expectancy: round(winRate * avgWin - lossRate * avgLoss),
    avgHoldDays: round(avgHoldDays),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    maxDrawdownPercent: computeDrawdown(closedTrades),
  };
}

function buildTrendByDate(benchmarkData) {
  const trendByDate = new Map();
  if (!benchmarkData) return trendByDate;

  for (let i = 200; i < benchmarkData.candles.length; i++) {
    const slice = {
      closes: benchmarkData.closes.slice(0, i + 1),
      highs: benchmarkData.highs.slice(0, i + 1),
      lows: benchmarkData.lows.slice(0, i + 1),
      price: benchmarkData.closes[i],
    };
    trendByDate.set(
      benchmarkData.candles[i].date,
      evaluateMarketRegime(slice)
    );
  }

  return trendByDate;
}

function resolveTrendForDate(trendByDate, orderedDates, targetDate) {
  let trend = null;
  for (const date of orderedDates) {
    if (date > targetDate) break;
    trend = trendByDate.get(date) || trend;
  }
  return trend;
}

export async function runBacktest({
  symbols = watchlist,
  lookbackDays = 365,
  maxConcurrentTrades = config.maxTrades,
  signalParams = {},
} = {}) {
  const dataLookback = Math.max(lookbackDays + 300, 3000);
  const benchmarkData = await getBenchmarkData({ lookbackDays: dataLookback });
  const trendByDate = buildTrendByDate(benchmarkData);
  const trendDates = [...trendByDate.keys()].sort();
  const openTrades = [];
  const closedTrades = [];

  for (const symbol of symbols) {
    const stockData = await getStockData(symbol, { lookbackDays: dataLookback });
    if (!stockData || stockData.candles.length < 220) {
      continue;
    }

    let activeTrade = null;
    const candles = stockData.candles;
    let cooldownUntilIndex = -1;
    const tradingStartIndex = Math.max(200, candles.length - lookbackDays);

    for (let i = tradingStartIndex; i < candles.length; i++) {
      const candle = candles[i];
      const historySlice = {
        symbol,
        dates: stockData.dates.slice(0, i + 1),
        opens: stockData.opens.slice(0, i + 1),
        highs: stockData.highs.slice(0, i + 1),
        lows: stockData.lows.slice(0, i + 1),
        closes: stockData.closes.slice(0, i + 1),
        volumes: stockData.volumes.slice(0, i + 1),
        candles: stockData.candles.slice(0, i + 1),
        price: candle.close,
      };

      if (activeTrade) {
        const daysHeld = i - activeTrade.entryIndex;
        const isShort = activeTrade.direction === 'short';
        let exitPrice = null;
        let exitReason = null;

        if (config.trailingStopEnabled && daysHeld >= config.trailingStopMinDays) {
          const riskPerShare = isShort
            ? activeTrade.originalStopLoss - activeTrade.entryPrice
            : activeTrade.entryPrice - activeTrade.originalStopLoss;
          if (riskPerShare > 0) {
            const unrealizedR = isShort
              ? (activeTrade.entryPrice - candle.close) / riskPerShare
              : (candle.close - activeTrade.entryPrice) / riskPerShare;
            if (unrealizedR >= config.trailingStopActivationR) {
              const sliceHighs = stockData.highs.slice(0, i + 1);
              const sliceLows = stockData.lows.slice(0, i + 1);
              const sliceCloses = stockData.closes.slice(0, i + 1);
              const atrValues = calculateATR(sliceHighs, sliceLows, sliceCloses, config.atrPeriod);
              const latestAtr = atrValues[atrValues.length - 1] ?? riskPerShare;
              if (isShort) {
                const atrTrailStop = round(candle.close + latestAtr * config.trailingStopAtrMultiplier);
                let newStop = Math.min(activeTrade.stopLoss, atrTrailStop);
                if (unrealizedR >= config.trailingStopBreakevenR) {
                  newStop = Math.min(newStop, activeTrade.entryPrice);
                }
                if (newStop < activeTrade.stopLoss) {
                  activeTrade.stopLoss = newStop;
                }
              } else {
                const atrTrailStop = round(candle.close - latestAtr * config.trailingStopAtrMultiplier);
                let newStop = Math.max(activeTrade.stopLoss, atrTrailStop);
                if (unrealizedR >= config.trailingStopBreakevenR) {
                  newStop = Math.max(newStop, activeTrade.entryPrice);
                }
                if (newStop > activeTrade.stopLoss) {
                  activeTrade.stopLoss = newStop;
                }
              }
            }
          }
        }

        if (isShort) {
          const trailMoved = activeTrade.stopLoss < activeTrade.originalStopLoss;
          if (candle.high >= activeTrade.stopLoss) {
            exitPrice = activeTrade.stopLoss;
            exitReason = trailMoved ? 'trailing_stop' : 'stop_loss';
          } else if (candle.low <= activeTrade.target) {
            exitPrice = activeTrade.target;
            exitReason = 'target_hit';
          } else if (daysHeld >= config.maxHoldDays) {
            exitPrice = candle.close;
            exitReason = 'time_exit';
          }
        } else {
          if (candle.low <= activeTrade.stopLoss) {
            exitPrice = activeTrade.stopLoss;
            exitReason = activeTrade.stopLoss > activeTrade.originalStopLoss ? 'trailing_stop' : 'stop_loss';
          } else if (candle.high >= activeTrade.target) {
            exitPrice = activeTrade.target;
            exitReason = 'target_hit';
          } else if (daysHeld >= config.maxHoldDays) {
            exitPrice = candle.close;
            exitReason = 'time_exit';
          }
        }

        if (exitPrice != null) {
          const slippageDir = isShort ? 1 : -1;
          const slippageAdjustedExit = round(
            exitPrice * (1 + slippageDir * config.exitSlippageBps / 10000)
          );
          const grossPnl = isShort
            ? (activeTrade.entryPrice - slippageAdjustedExit) * activeTrade.qty
            : (slippageAdjustedExit - activeTrade.entryPrice) * activeTrade.qty;
          const tradeCost = computeTradeCost(activeTrade.entryPrice, slippageAdjustedExit, activeTrade.qty);
          const pnl = round(grossPnl - tradeCost);
          const closed = {
            ...activeTrade,
            status: 'closed',
            exitDate: candle.date,
            exitPrice: slippageAdjustedExit,
            pnl,
            grossPnl: round(grossPnl),
            tradeCost: round(tradeCost),
            exitReason,
            daysHeld,
          };

          closedTrades.push(closed);
          const openIndex = openTrades.findIndex((trade) => trade.id === activeTrade.id);
          if (openIndex >= 0) {
            openTrades.splice(openIndex, 1);
          }
          if (exitReason === 'stop_loss') {
            cooldownUntilIndex = i + 20;
          }
          activeTrade = null;
        }

        continue;
      }

      if (openTrades.length >= maxConcurrentTrades) {
        continue;
      }

      if (i <= cooldownUntilIndex) {
        continue;
      }

      const marketTrend = resolveTrendForDate(trendByDate, trendDates, candle.date);
      const benchmarkSlice = benchmarkData
        ? {
          closes: benchmarkData.candles
            .filter((row) => row.date <= candle.date)
            .map((row) => row.close),
          price: benchmarkData.candles
            .filter((row) => row.date <= candle.date)
            .slice(-1)[0]?.close ?? benchmarkData.price,
        }
        : null;
      const signal = evaluateStock(historySlice, {
        marketTrend,
        benchmarkData: benchmarkSlice,
        params: signalParams,
      });
      if (!signal.shouldBuy) {
        continue;
      }

      const isShort = signal.direction === 'short';
      const slippageMultiplier = isShort ? -1 : 1;
      const entryWithSlippage = round(candle.close * (1 + slippageMultiplier * config.entrySlippageBps / 10000));

      const atrSlice = calculateATR(
        stockData.highs.slice(0, i + 1),
        stockData.lows.slice(0, i + 1),
        stockData.closes.slice(0, i + 1),
        config.atrPeriod
      );
      const entryAtr = atrSlice[atrSlice.length - 1] ?? 0;

      const stopRef = isShort
        ? round(entryWithSlippage * (1 + config.stopLossPercent))
        : round(entryWithSlippage * (1 - config.stopLossPercent));
      let qty = calculatePositionSize(entryWithSlippage, stopRef, isShort ? 'short' : 'long');
      if (signal.isCounterTrend) {
        qty = Math.floor(qty * config.counterTrendSizeMultiplier);
      }
      if (qty <= 0) {
        continue;
      }

      let initialStopLoss, realisticTarget;
      if (isShort) {
        initialStopLoss = round(entryWithSlippage * (1 + config.stopLossPercent));
        const fixedTarget = entryWithSlippage * (1 - config.targetPercent);
        const supportTarget = signal.supportLevel < entryWithSlippage ? signal.supportLevel : fixedTarget;
        const atrTarget = entryAtr > 0 ? entryWithSlippage - entryAtr * 2 : fixedTarget;
        realisticTarget = round(Math.max(fixedTarget, supportTarget, atrTarget));
      } else {
        initialStopLoss = round(entryWithSlippage * (1 - config.stopLossPercent));
        const fixedTarget = entryWithSlippage * (1 + config.targetPercent);
        const resistanceTarget = signal.resistanceLevel > entryWithSlippage ? signal.resistanceLevel : fixedTarget;
        const atrTarget = entryAtr > 0 ? entryWithSlippage + entryAtr * 2 : fixedTarget;
        realisticTarget = round(Math.min(fixedTarget, resistanceTarget, atrTarget));
      }

      activeTrade = {
        id: `${symbol}-${candle.date}`,
        symbol,
        direction: isShort ? 'short' : 'long',
        qty,
        entryPrice: entryWithSlippage,
        entryDate: candle.date,
        stopLoss: initialStopLoss,
        originalStopLoss: initialStopLoss,
        target: realisticTarget,
        entryIndex: i,
        signalMeta: {
          strategy: signal.strategy,
          reason: signal.reason,
          rsi: signal.rsi,
          atrPercent: signal.atrPercent,
          volumeRatio: signal.volumeRatio,
          relativeStrength: signal.relativeStrength,
          supportLevel: signal.supportLevel,
          resistanceLevel: signal.resistanceLevel,
          riskReward: signal.riskReward,
          confidenceScore: signal.confidenceScore,
          isCounterTrend: signal.isCounterTrend ?? false,
        },
      };

      openTrades.push(activeTrade);
    }
  }

  const summary = summarizeTrades(closedTrades);
  const longTrades = closedTrades.filter((t) => t.direction !== 'short');
  const shortTrades = closedTrades.filter((t) => t.direction === 'short');
  const totalCosts = closedTrades.reduce((s, t) => s + (t.tradeCost || 0), 0);
  const totalGrossPnl = closedTrades.reduce((s, t) => s + (t.grossPnl ?? t.pnl ?? 0), 0);
  const attribution = buildAttribution(closedTrades);
  return {
    config: {
      lookbackDays,
      symbolsCount: symbols.length,
      maxConcurrentTrades,
      signalParams,
      stopLossPercent: config.stopLossPercent,
      targetPercent: config.targetPercent,
      maxHoldDays: config.maxHoldDays,
      tradeCostFixed: config.tradeCostFixed,
      tradeCostPercent: config.tradeCostPercent,
      trailingStopEnabled: config.trailingStopEnabled,
    },
    benchmarkTrend: evaluateMarketRegime(benchmarkData),
    summary: {
      ...summary,
      longTrades: longTrades.length,
      shortTrades: shortTrades.length,
      longPnl: round(longTrades.reduce((s, t) => s + t.pnl, 0)),
      shortPnl: round(shortTrades.reduce((s, t) => s + t.pnl, 0)),
      totalGrossPnl: round(totalGrossPnl),
      totalCosts: round(totalCosts),
    },
    attribution,
    trades: closedTrades.sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate)),
  };
}

function buildAttribution(closedTrades) {
  const bucketDefs = {
    rsi: [
      { label: 'RSI < 30', test: (t) => (t.signalMeta?.rsi ?? 50) < 30 },
      { label: 'RSI 30-40', test: (t) => { const r = t.signalMeta?.rsi ?? 50; return r >= 30 && r < 40; } },
      { label: 'RSI 40-50', test: (t) => { const r = t.signalMeta?.rsi ?? 50; return r >= 40 && r < 50; } },
      { label: 'RSI 50-60', test: (t) => { const r = t.signalMeta?.rsi ?? 50; return r >= 50 && r < 60; } },
      { label: 'RSI >= 60', test: (t) => (t.signalMeta?.rsi ?? 50) >= 60 },
    ],
    relativeStrength: [
      { label: 'RS < -2', test: (t) => (t.signalMeta?.relativeStrength ?? 0) < -2 },
      { label: 'RS -2 to 0', test: (t) => { const rs = t.signalMeta?.relativeStrength ?? 0; return rs >= -2 && rs < 0; } },
      { label: 'RS 0 to 2', test: (t) => { const rs = t.signalMeta?.relativeStrength ?? 0; return rs >= 0 && rs < 2; } },
      { label: 'RS >= 2', test: (t) => (t.signalMeta?.relativeStrength ?? 0) >= 2 },
    ],
    volumeRatio: [
      { label: 'Vol < 0.8', test: (t) => (t.signalMeta?.volumeRatio ?? 1) < 0.8 },
      { label: 'Vol 0.8-1.2', test: (t) => { const v = t.signalMeta?.volumeRatio ?? 1; return v >= 0.8 && v < 1.2; } },
      { label: 'Vol 1.2-2.0', test: (t) => { const v = t.signalMeta?.volumeRatio ?? 1; return v >= 1.2 && v < 2.0; } },
      { label: 'Vol >= 2.0', test: (t) => (t.signalMeta?.volumeRatio ?? 1) >= 2.0 },
    ],
    atrPercent: [
      { label: 'ATR < 1.5%', test: (t) => (t.signalMeta?.atrPercent ?? 0) < 1.5 },
      { label: 'ATR 1.5-2.5%', test: (t) => { const a = t.signalMeta?.atrPercent ?? 0; return a >= 1.5 && a < 2.5; } },
      { label: 'ATR 2.5-4%', test: (t) => { const a = t.signalMeta?.atrPercent ?? 0; return a >= 2.5 && a < 4; } },
      { label: 'ATR >= 4%', test: (t) => (t.signalMeta?.atrPercent ?? 0) >= 4 },
    ],
    riskReward: [
      { label: 'RR < 1.5', test: (t) => (t.signalMeta?.riskReward ?? 0) < 1.5 },
      { label: 'RR 1.5-2.5', test: (t) => { const rr = t.signalMeta?.riskReward ?? 0; return rr >= 1.5 && rr < 2.5; } },
      { label: 'RR 2.5-4', test: (t) => { const rr = t.signalMeta?.riskReward ?? 0; return rr >= 2.5 && rr < 4; } },
      { label: 'RR >= 4', test: (t) => (t.signalMeta?.riskReward ?? 0) >= 4 },
    ],
    exitReason: [
      { label: 'Target Hit', test: (t) => t.exitReason === 'target_hit' },
      { label: 'Stop Loss', test: (t) => t.exitReason === 'stop_loss' },
      { label: 'Trailing Stop', test: (t) => t.exitReason === 'trailing_stop' },
      { label: 'Time Exit', test: (t) => t.exitReason === 'time_exit' },
    ],
    daysHeld: [
      { label: '1-3 days', test: (t) => (t.daysHeld ?? 0) <= 3 },
      { label: '4-7 days', test: (t) => { const d = t.daysHeld ?? 0; return d >= 4 && d <= 7; } },
      { label: '8-14 days', test: (t) => { const d = t.daysHeld ?? 0; return d >= 8 && d <= 14; } },
      { label: '15+ days', test: (t) => (t.daysHeld ?? 0) >= 15 },
    ],
    confidenceScore: [
      { label: 'Conf 0-0.3', test: (t) => (t.signalMeta?.confidenceScore ?? 0.5) < 0.3 },
      { label: 'Conf 0.3-0.6', test: (t) => { const c = t.signalMeta?.confidenceScore ?? 0.5; return c >= 0.3 && c < 0.6; } },
      { label: 'Conf 0.6-1.0', test: (t) => (t.signalMeta?.confidenceScore ?? 0.5) >= 0.6 },
    ],
  };

  function computeBucketStats(trades) {
    if (trades.length === 0) return { count: 0, wins: 0, winRate: 0, avgWin: 0, avgLoss: 0, expectancy: 0, totalPnl: 0 };
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl < 0);
    const winRate = wins.length / trades.length;
    const lossRate = losses.length / trades.length;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    return {
      count: trades.length,
      wins: wins.length,
      winRate: round(winRate * 100),
      avgWin: round(avgWin),
      avgLoss: round(avgLoss),
      expectancy: round(winRate * avgWin - lossRate * avgLoss),
      totalPnl: round(trades.reduce((s, t) => s + t.pnl, 0)),
    };
  }

  const bucketAnalysis = {};
  for (const [dimension, buckets] of Object.entries(bucketDefs)) {
    bucketAnalysis[dimension] = buckets.map((bucket) => ({
      label: bucket.label,
      ...computeBucketStats(closedTrades.filter(bucket.test)),
    }));
  }

  const strategyNameMap = {};
  for (const trade of closedTrades) {
    const name = trade.signalMeta?.strategy || 'unknown';
    if (!strategyNameMap[name]) strategyNameMap[name] = [];
    strategyNameMap[name].push(trade);
  }

  const strategyBreakdown = Object.entries(strategyNameMap)
    .map(([strategy, trades]) => ({
      strategy,
      direction: trades[0]?.direction || 'unknown',
      ...computeBucketStats(trades),
    }))
    .sort((a, b) => b.expectancy - a.expectancy);

  const directionBreakdown = {
    long: computeBucketStats(closedTrades.filter((t) => t.direction !== 'short')),
    short: computeBucketStats(closedTrades.filter((t) => t.direction === 'short')),
  };

  const symbolBreakdown = {};
  for (const trade of closedTrades) {
    if (!symbolBreakdown[trade.symbol]) symbolBreakdown[trade.symbol] = [];
    symbolBreakdown[trade.symbol].push(trade);
  }
  const perSymbol = Object.entries(symbolBreakdown)
    .map(([symbol, trades]) => ({ symbol, ...computeBucketStats(trades) }))
    .sort((a, b) => b.expectancy - a.expectancy);

  const edgeFilters = [];
  for (const [dimension, buckets] of Object.entries(bucketAnalysis)) {
    for (const bucket of buckets) {
      if (bucket.count >= 3 && bucket.expectancy < 0) {
        edgeFilters.push({
          dimension,
          bucket: bucket.label,
          count: bucket.count,
          expectancy: bucket.expectancy,
          winRate: bucket.winRate,
          recommendation: `Disable or tighten: ${bucket.label} (${bucket.count} trades, expectancy ${bucket.expectancy})`,
        });
      }
    }
  }
  edgeFilters.sort((a, b) => a.expectancy - b.expectancy);

  const edgeProfile = deriveEdgeProfile(bucketAnalysis, strategyBreakdown);

  return {
    bucketAnalysis,
    strategyBreakdown,
    directionBreakdown,
    perSymbol,
    edgeFilters,
    edgeProfile,
  };
}

function deriveEdgeProfile(bucketAnalysis, strategyBreakdown) {
  const MIN_TRADES = 5;

  function bestRange(buckets) {
    const profitable = buckets.filter((b) => b.count >= MIN_TRADES && b.expectancy > 0);
    if (profitable.length === 0) return null;
    profitable.sort((a, b) => b.expectancy - a.expectancy);
    return profitable.map((b) => b.label);
  }

  function parseRange(label) {
    const nums = label.match(/-?\d+\.?\d*/g);
    return nums ? nums.map(Number) : [];
  }

  function extractBounds(labels) {
    if (!labels || labels.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const label of labels) {
      if (label.includes('<') || label.includes('< ')) {
        const nums = parseRange(label);
        if (nums.length > 0) { min = Math.min(min, -Infinity); max = Math.max(max, nums[0]); }
      } else if (label.includes('>') || label.includes('>=')) {
        const nums = parseRange(label);
        if (nums.length > 0) { min = Math.min(min, nums[nums.length - 1]); max = Infinity; }
      } else {
        const nums = parseRange(label);
        if (nums.length >= 2) { min = Math.min(min, nums[0]); max = Math.max(max, nums[1]); }
        else if (nums.length === 1) { min = Math.min(min, nums[0]); max = Math.max(max, nums[0]); }
      }
    }
    return { min: min === Infinity ? null : min, max: max === -Infinity ? null : max };
  }

  const rsiBest = bestRange(bucketAnalysis.rsi || []);
  const volBest = bestRange(bucketAnalysis.volumeRatio || []);
  const rrBest = bestRange(bucketAnalysis.riskReward || []);
  const atrBest = bestRange(bucketAnalysis.atrPercent || []);

  const strategyWeights = {};
  const totalExpectancy = strategyBreakdown
    .filter((s) => s.count >= MIN_TRADES && s.expectancy > 0)
    .reduce((sum, s) => sum + s.expectancy * s.count, 0);

  for (const s of strategyBreakdown) {
    if (s.count >= MIN_TRADES && s.expectancy > 0 && totalExpectancy > 0) {
      strategyWeights[s.strategy] = round((s.expectancy * s.count) / totalExpectancy);
    } else if (s.count >= MIN_TRADES) {
      strategyWeights[s.strategy] = 0;
    }
  }

  return {
    rsi: extractBounds(rsiBest),
    volumeRatio: extractBounds(volBest),
    riskReward: extractBounds(rrBest),
    atrPercent: extractBounds(atrBest),
    profitableBuckets: { rsi: rsiBest, volumeRatio: volBest, riskReward: rrBest, atrPercent: atrBest },
    strategyWeights,
  };
}

export async function runParameterSensitivity({
  lookbackDays = 365,
  grid = {},
} = {}) {
  const rsiRanges = grid.rsiRanges ?? [
    { rsiLower: 30, rsiUpper: 45 },
    { rsiLower: 25, rsiUpper: 40 },
    { rsiLower: 35, rsiUpper: 50 },
  ];
  const atrThresholds = grid.minAtrPercents ?? [1, 1.2, 1.5];
  const rrThresholds = grid.minRiskRewards ?? [1.5, 2, 2.5];

  const results = [];
  for (const rsiRange of rsiRanges) {
    for (const minAtrPercent of atrThresholds) {
      for (const minRiskReward of rrThresholds) {
        const signalParams = {
          ...rsiRange,
          minAtrPercent,
          minRiskReward,
        };
        const backtest = await runBacktest({ lookbackDays, signalParams });
        results.push({
          signalParams,
          summary: backtest.summary,
        });
      }
    }
  }

  const ranked = results.sort((a, b) => (b.summary.expectancy || 0) - (a.summary.expectancy || 0));
  return {
    lookbackDays,
    combinations: results.length,
    topResults: ranked.slice(0, 10),
    allResults: ranked,
  };
}

export async function runWalkForwardTest({
  trainDays = 3 * 365,
  testDays = 2 * 365,
} = {}) {
  const training = await runParameterSensitivity({ lookbackDays: trainDays });
  const best = training.topResults[0]?.signalParams ?? {};
  const test = await runBacktest({
    lookbackDays: testDays,
    signalParams: best,
  });
  return {
    trainingWindowDays: trainDays,
    testingWindowDays: testDays,
    selectedParams: best,
    trainingTopSummary: training.topResults[0]?.summary ?? null,
    testSummary: test.summary,
    testTrades: test.trades,
  };
}

export function runMonteCarloSimulation({
  trades = [],
  iterations = 500,
  slippageNoiseBps = 30,
  delayLossPercent = 0.002,
} = {}) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return {
      iterations,
      scenarios: [],
      worstCaseDrawdown: 0,
      p5Pnl: 0,
      p95Pnl: 0,
    };
  }

  const scenarios = [];
  for (let i = 0; i < iterations; i++) {
    const shuffled = [...trades].sort(() => Math.random() - 0.5);
    let equity = config.capital;
    let peak = equity;
    let maxDrawdown = 0;
    let totalPnl = 0;

    for (const trade of shuffled) {
      const slippageNoise = (Math.random() * 2 - 1) * (slippageNoiseBps / 10000);
      const delayPenalty = Math.random() < 0.35 ? delayLossPercent : 0;
      const adjustedPnl = trade.pnl * (1 - delayPenalty + slippageNoise);
      totalPnl += adjustedPnl;
      equity += adjustedPnl;
      peak = Math.max(peak, equity);
      const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }

    scenarios.push({
      totalPnl: round(totalPnl),
      maxDrawdownPercent: round(maxDrawdown),
    });
  }

  const sortedPnl = scenarios.map((row) => row.totalPnl).sort((a, b) => a - b);
  const p5Index = Math.floor(iterations * 0.05);
  const p95Index = Math.floor(iterations * 0.95);

  return {
    iterations,
    scenarios,
    worstCaseDrawdown: round(Math.max(...scenarios.map((row) => row.maxDrawdownPercent))),
    p5Pnl: sortedPnl[p5Index],
    p95Pnl: sortedPnl[p95Index],
  };
}
