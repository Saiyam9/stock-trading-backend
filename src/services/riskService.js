import { config } from '../config/env.js';
import { getAllTrades, getOpenTrades } from './tradeService.js';
import { logger } from '../utils/logger.js';
import { formatINR, formatPercent } from '../utils/helpers.js';
import { symbolSectorMap } from '../config/stocks.js';
import { calculateATR, calculateCorrelation } from './indicatorService.js';

export function calculatePositionSize(price, stopLoss = null, direction = 'long') {
  if (!Number.isFinite(price) || price <= 0) return 0;

  const riskPerShare = direction === 'short'
    ? (Number.isFinite(stopLoss) && stopLoss > price ? stopLoss - price : null)
    : (Number.isFinite(stopLoss) && stopLoss < price ? price - stopLoss : null);

  if (riskPerShare == null || riskPerShare <= 0) {
    return Math.floor(config.perTradeCapital / price);
  }

  const riskPerTrade = config.capital * config.riskPerTradePercent;
  const qtyByRisk = Math.floor(riskPerTrade / riskPerShare);
  const qtyByCapital = Math.floor(config.perTradeCapital / price);
  return Math.max(0, Math.min(qtyByRisk, qtyByCapital));
}

let _dynamicStrategyWeights = null;

export function setDynamicStrategyWeights(weights) {
  _dynamicStrategyWeights = weights;
}

function getStrategyWeight(strategy = 'mean_reversion') {
  if (config.useDynamicStrategyWeights && _dynamicStrategyWeights) {
    const w = _dynamicStrategyWeights[strategy];
    if (w != null && w > 0) return w;
    if (w === 0) return 0.05;
  }
  if (strategy === 'breakout') return config.strategyWeightBreakout;
  if (strategy === 'trend_following') return config.strategyWeightTrend;
  return config.strategyWeightMeanReversion;
}

function getKellyFactor(strategy = 'mean_reversion') {
  if (!config.useKellySizing) return 1;
  const closedTrades = getAllTrades().filter((trade) => trade.status === 'closed');
  const strategyTrades = closedTrades.filter((trade) => trade.signalTag?.strategy === strategy);
  if (strategyTrades.length < 10) return 1;
  const wins = strategyTrades.filter((trade) => trade.pnl > 0);
  const losses = strategyTrades.filter((trade) => trade.pnl <= 0);
  if (wins.length === 0 || losses.length === 0) return 1;
  const winRate = wins.length / strategyTrades.length;
  const avgWin = wins.reduce((sum, trade) => sum + trade.pnl, 0) / wins.length;
  const avgLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0) / losses.length);
  if (avgLoss === 0) return 1;
  const edge = winRate - ((1 - winRate) / (avgWin / avgLoss));
  return Math.max(0.1, Math.min(edge, config.kellyFractionCap));
}

function getVolatilityScalar(stockData = null) {
  if (!stockData || !stockData.highs || stockData.highs.length < 30) return 1;
  const atrValues = calculateATR(stockData.highs, stockData.lows, stockData.closes, 14);
  if (atrValues.length < 20) return 1;
  const latestAtr = atrValues[atrValues.length - 1];
  const avgAtr = atrValues.slice(-20).reduce((s, v) => s + v, 0) / 20;
  if (avgAtr === 0) return 1;
  const ratio = latestAtr / avgAtr;
  if (ratio > 1.5) return 0.6;
  if (ratio > 1.2) return 0.8;
  if (ratio < 0.7) return 1.2;
  return 1;
}

function getCorrelationScalar(stockCloses = null, openTrades = null) {
  if (!stockCloses || !openTrades || openTrades.length === 0) return 1;
  let maxCorr = 0;
  for (const trade of openTrades) {
    if (trade._closes) {
      const corr = calculateCorrelation(stockCloses, trade._closes, 60);
      if (corr != null) maxCorr = Math.max(maxCorr, Math.abs(corr));
    }
  }
  if (maxCorr > 0.7) return 0.6;
  if (maxCorr > 0.5) return 0.8;
  return 1;
}

export function calculateWeightedPositionSize(price, stopLoss, signal = {}, stockData = null) {
  const baseQty = calculatePositionSize(price, stopLoss, signal.direction ?? 'long');
  if (baseQty <= 0) return 0;
  const strategyWeight = Math.max(0.1, getStrategyWeight(signal.strategy));
  const kellyFactor = getKellyFactor(signal.strategy);
  const volScalar = getVolatilityScalar(stockData);
  const exposureMultiplier = signal.exposureMultiplier ?? 1;
  const counterTrendMultiplier = signal.isCounterTrend ? config.counterTrendSizeMultiplier : 1;
  return Math.max(0, Math.floor(baseQty * strategyWeight * kellyFactor * volScalar * exposureMultiplier * counterTrendMultiplier));
}

export function getPortfolioRisk(openTrades) {
  const currentOpenTrades = openTrades ?? getOpenTrades();
  return currentOpenTrades.reduce((sum, trade) => {
    const tradeRisk = Math.max((trade.entryPrice - trade.stopLoss) * trade.qty, 0);
    return sum + tradeRisk;
  }, 0);
}

export function exceedsPortfolioRiskCap() {
  const openTrades = getOpenTrades();
  const totalRisk = getPortfolioRisk(openTrades);
  const riskLimit = config.capital * config.maxPortfolioRiskPercent;
  if (totalRisk > riskLimit) {
    logger.warn(
      `Portfolio risk cap hit: ${formatINR(totalRisk)} > ${formatINR(riskLimit)} (${formatPercent(config.maxPortfolioRiskPercent)})`
    );
    return true;
  }
  return false;
}

export function isDrawdownPaused() {
  const allTrades = getAllTrades()
    .filter((trade) => trade.status === 'closed')
    .sort((a, b) => new Date(a.exitDate) - new Date(b.exitDate));

  let equity = config.capital;
  let peak = equity;
  let maxDrawdown = 0;
  let lastDrawdownExitDate = null;

  for (const trade of allTrades) {
    equity += Number(trade.pnl || 0);
    if (equity >= peak) peak = equity;
    const drawdown = peak > 0 ? (peak - equity) / peak : 0;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      lastDrawdownExitDate = trade.exitDate;
    }
  }

  if (maxDrawdown < config.maxDrawdownPercent || !lastDrawdownExitDate) {
    return { paused: false, maxDrawdownPercent: Math.round(maxDrawdown * 10000) / 100 };
  }

  const pauseUntil = new Date(lastDrawdownExitDate);
  pauseUntil.setDate(pauseUntil.getDate() + config.drawdownPauseDays);
  const paused = new Date() < pauseUntil;

  if (paused) {
    logger.warn(
      `Drawdown pause active: drawdown ${(maxDrawdown * 100).toFixed(2)}% >= ${(config.maxDrawdownPercent * 100).toFixed(2)}% until ${pauseUntil.toISOString()}`
    );
  }

  return {
    paused,
    maxDrawdownPercent: Math.round(maxDrawdown * 10000) / 100,
    pauseUntil: pauseUntil.toISOString(),
  };
}

export function exceedsSectorExposure(symbol) {
  const sector = symbolSectorMap[symbol];
  if (!sector) return false;
  const openTrades = getOpenTrades();
  const sectorCount = openTrades.filter((trade) => symbolSectorMap[trade.symbol] === sector).length;
  if (sectorCount >= config.maxSectorTrades) {
    logger.info(
      `Sector diversification guard: ${sector} has ${sectorCount} open trades (max ${config.maxSectorTrades})`
    );
    return true;
  }
  return false;
}

export function exceedsSectorCapitalExposure(symbol, candidateCapital = 0) {
  const sector = symbolSectorMap[symbol];
  if (!sector) return false;
  const openTrades = getOpenTrades();
  const currentExposure = openTrades
    .filter((trade) => symbolSectorMap[trade.symbol] === sector)
    .reduce((sum, trade) => sum + trade.entryPrice * trade.qty, 0);
  const maxSectorCapital = config.capital * config.maxSectorCapitalPercent;
  const projected = currentExposure + candidateCapital;
  if (projected > maxSectorCapital) {
    logger.info(
      `Sector capital cap hit: ${sector} projected ${formatINR(projected)} > ${formatINR(maxSectorCapital)}`
    );
    return true;
  }
  return false;
}

export function canTakeNewTrade() {
  const openTrades = getOpenTrades();
  if (openTrades.length >= config.maxTrades) {
    logger.info(
      `Max trades reached (${openTrades.length}/${config.maxTrades}). Skipping new entries.`
    );
    return false;
  }
  if (exceedsPortfolioRiskCap()) {
    return false;
  }
  const drawdownState = isDrawdownPaused();
  if (drawdownState.paused) {
    return false;
  }
  return true;
}

/**
 * Circuit breaker: halts trading if daily realized + unrealized loss
 * exceeds 2% of total capital.
 */
export function checkDailyLossCircuitBreaker(currentPrices = {}) {
  const openTrades = getOpenTrades();
  const maxDailyLoss = config.capital * 0.02;

  let totalUnrealizedLoss = 0;
  for (const trade of openTrades) {
    const currentPrice = currentPrices[trade.symbol] || trade.entryPrice;
    const pnl = (currentPrice - trade.entryPrice) * trade.qty;
    if (pnl < 0) totalUnrealizedLoss += Math.abs(pnl);
  }

  if (totalUnrealizedLoss >= maxDailyLoss) {
    logger.warn(
      `CIRCUIT BREAKER: Unrealized loss ${formatINR(totalUnrealizedLoss)} exceeds ${formatPercent(0.02)} of capital (${formatINR(maxDailyLoss)}). Halting new trades.`
    );
    return true;
  }

  return false;
}
