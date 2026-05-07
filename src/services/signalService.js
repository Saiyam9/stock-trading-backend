import {
  calculateATR,
  calculateEMA,
  calculateReturnPercent,
  calculateRSI,
  getSupportResistanceLevels,
  isNearSupport,
} from './indicatorService.js';
import { config } from '../config/env.js';

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function getSignalMetrics(stockData, context = {}) {
  const { benchmarkData = null, params = {} } = context;
  const rsiValues = calculateRSI(stockData.closes);
  if (rsiValues.length === 0 || stockData.closes.length < 30) {
    return {
      rsi: null,
      atr: null,
      atrPercent: null,
      stockReturn: null,
      benchmarkReturn: null,
      levels: null,
      nearSupport: false,
      riskReward: 0,
      volumeSpike: false,
      volumeRatio: null,
      avgVolume: null,
      liquidityOk: false,
    };
  }

  const atrPeriod = params.atrPeriod ?? config.atrPeriod;
  const rsLookback = params.relativeStrengthLookback ?? config.relativeStrengthLookback;
  const volumeSpikeMultiplier = params.volumeSpikeMultiplier ?? config.volumeSpikeMultiplier;
  const minAvgVolume = params.minAvgVolume ?? config.minAvgVolume;

  const latestRSI = rsiValues[rsiValues.length - 1];
  const atrValues = calculateATR(stockData.highs, stockData.lows, stockData.closes, atrPeriod);
  const latestAtr = atrValues[atrValues.length - 1] ?? null;
  const atrPercent = latestAtr != null ? (latestAtr / stockData.price) * 100 : 0;
  const stockReturn = calculateReturnPercent(stockData.closes, rsLookback);
  const benchmarkReturn = benchmarkData
    ? calculateReturnPercent(benchmarkData.closes, rsLookback)
    : null;
  const shortTermReturn = calculateReturnPercent(stockData.closes, 10);
  const benchmarkShortTermReturn = benchmarkData
    ? calculateReturnPercent(benchmarkData.closes, 10)
    : null;

  const latestVolume = stockData.volumes[stockData.volumes.length - 1] ?? 0;
  const recentVolumes = stockData.volumes.slice(-21, -1);
  const avgVolume = recentVolumes.length > 0
    ? recentVolumes.reduce((sum, value) => sum + value, 0) / recentVolumes.length
    : 0;
  const volumeSpike = avgVolume > 0
    ? latestVolume >= avgVolume * volumeSpikeMultiplier
    : false;
  const liquidityOk = avgVolume >= minAvgVolume;

  const levels = getSupportResistanceLevels(stockData);
  const nearSupport = isNearSupport(stockData);
  const riskPerShare = Math.max(stockData.price - levels.supportLevel, 0.01);
  const atrCappedTarget = latestAtr != null ? stockData.price + latestAtr * 2 : Infinity;
  const realisticUpside = Math.min(levels.resistanceLevel, atrCappedTarget);
  const rewardPerShare = Math.max(realisticUpside - stockData.price, 0);
  const riskReward = rewardPerShare > 0 ? rewardPerShare / riskPerShare : 0;

  const minShortRisk = stockData.price * config.stopLossPercent;
  const shortRiskPerShare = Math.max(levels.resistanceLevel - stockData.price, minShortRisk, 0.01);
  const atrCappedShortTarget = latestAtr != null ? stockData.price - latestAtr * 2 : 0;
  const realisticDownside = Math.max(levels.supportLevel, atrCappedShortTarget, 0);
  const shortRewardPerShare = Math.max(stockData.price - realisticDownside, 0);
  const shortRiskReward = shortRewardPerShare > 0 ? shortRewardPerShare / shortRiskPerShare : 0;

  const nearResistance = levels.resistanceLevel > 0 &&
    stockData.price >= levels.resistanceLevel * 0.95;

  return {
    rsi: latestRSI,
    atr: latestAtr,
    atrPercent,
    stockReturn,
    benchmarkReturn,
    shortTermReturn,
    benchmarkShortTermReturn,
    levels,
    nearSupport,
    nearResistance,
    riskReward,
    shortRiskReward,
    volumeSpike,
    volumeRatio: avgVolume > 0 ? latestVolume / avgVolume : null,
    avgVolume,
    liquidityOk,
  };
}

function getTradeRiskReward() {
  return config.stopLossPercent > 0 ? config.targetPercent / config.stopLossPercent : 0;
}

function applyEdgeFilters(metrics, direction) {
  if (direction === 'short') return { pass: true, rejectReason: null };

  if (metrics.rsi != null && metrics.rsi > 45) {
    return { pass: false, rejectReason: 'edge_filter_rsi_above_45' };
  }

  if (metrics.volumeRatio != null && metrics.volumeRatio >= 1.2 && metrics.volumeRatio < 2.0) {
    return { pass: false, rejectReason: 'edge_filter_volume_dead_zone' };
  }

  if (metrics.volumeRatio != null && metrics.volumeRatio > 5.0) {
    return { pass: false, rejectReason: 'edge_filter_volume_extreme_spike' };
  }

  if (metrics.riskReward >= 2.5 && metrics.riskReward < 4) {
    return { pass: false, rejectReason: 'edge_filter_rr_dead_zone' };
  }

  if (metrics.riskReward > 10) {
    return { pass: false, rejectReason: 'edge_filter_rr_unrealistic' };
  }

  if (metrics.atrPercent >= 1.5 && metrics.atrPercent < 2.5) {
    return { pass: false, rejectReason: 'edge_filter_atr_dead_zone' };
  }

  if (metrics.atrPercent > 6) {
    return { pass: false, rejectReason: 'edge_filter_atr_extreme' };
  }

  const relativeStrength = metrics.stockReturn != null && metrics.benchmarkReturn != null
    ? metrics.stockReturn - metrics.benchmarkReturn
    : null;
  if (relativeStrength != null && relativeStrength < -5) {
    return { pass: false, rejectReason: 'edge_filter_rs_extreme_weakness' };
  }

  return { pass: true, rejectReason: null };
}

function formatBaseSignal(stockData, marketTrend, metrics, shouldBuy, reason, strategy, direction = 'long') {
  const tradeRR = rounded(getTradeRiskReward());
  const rr = direction === 'short' ? (metrics.shortRiskReward ?? 0) : (metrics.riskReward ?? 0);
  return {
    shouldBuy,
    direction,
    strategy,
    entryPrice: stockData.price,
    rsi: metrics.rsi == null ? null : rounded(metrics.rsi),
    nearSupport: metrics.nearSupport,
    supportLevel: metrics.levels?.supportLevel ?? null,
    resistanceLevel: metrics.levels?.resistanceLevel ?? null,
    supportTouches: metrics.levels?.supportTouches ?? null,
    resistanceTouches: metrics.levels?.resistanceTouches ?? null,
    supportMethod: metrics.levels?.method ?? null,
    riskReward: rounded(rr),
    tradeRiskReward: tradeRR,
    atr: metrics.atr == null ? null : rounded(metrics.atr),
    atrPercent: metrics.atrPercent == null ? null : rounded(metrics.atrPercent),
    relativeStrength: metrics.stockReturn == null || metrics.benchmarkReturn == null
      ? null
      : rounded(metrics.stockReturn - metrics.benchmarkReturn),
    stockReturn20d: metrics.stockReturn == null ? null : rounded(metrics.stockReturn),
    benchmarkReturn20d: metrics.benchmarkReturn == null ? null : rounded(metrics.benchmarkReturn),
    volumeRatio: metrics.volumeRatio == null ? null : rounded(metrics.volumeRatio),
    volumeSpike: metrics.volumeSpike,
    liquidityOk: metrics.liquidityOk,
    marketTrend,
    reason,
  };
}

export function generateMeanReversionSignal(stockData, context = {}) {
  const { marketTrend = null, params = {} } = context;
  const metrics = getSignalMetrics(stockData, context);
  if (metrics.rsi == null || !metrics.levels) {
    return formatBaseSignal(stockData, marketTrend, metrics, false, 'insufficient_rsi_data', 'mean_reversion');
  }

  const rsiLower = params.rsiLower ?? 30;
  const rsiUpper = params.rsiUpper ?? 45;
  const minRiskReward = params.minRiskReward ?? config.minRiskReward;
  const minAtrPercent = params.minAtrPercent ?? config.minAtrPercent;

  const rsiInZone = metrics.rsi >= rsiLower && metrics.rsi <= rsiUpper;
  const resistanceAbovePrice = metrics.levels.resistanceLevel > stockData.price;
  const goodRiskReward = metrics.riskReward >= minRiskReward;
  const atrAllowed = metrics.atrPercent >= minAtrPercent;
  const volumeOk = metrics.volumeRatio != null && metrics.volumeRatio >= 0.8;

  const edgeCheck = applyEdgeFilters(metrics, 'long');

  const shouldBuy = rsiInZone &&
    metrics.nearSupport &&
    resistanceAbovePrice &&
    goodRiskReward &&
    atrAllowed &&
    volumeOk &&
    edgeCheck.pass;

  let reason = 'no_signal';
  if (!rsiInZone) reason = 'rsi_out_of_entry_zone';
  else if (!metrics.nearSupport) reason = 'not_near_support';
  else if (!atrAllowed) reason = 'low_volatility_filter';
  else if (!volumeOk) reason = 'volume_below_avg';
  else if (!resistanceAbovePrice) reason = 'no_nearby_upside_resistance';
  else if (!goodRiskReward) reason = 'insufficient_risk_reward';
  else if (!edgeCheck.pass) reason = edgeCheck.rejectReason;
  else reason = 'valid_buy_setup';

  return formatBaseSignal(stockData, marketTrend, metrics, shouldBuy, reason, 'mean_reversion');
}

export function generateBreakoutSignal(stockData, context = {}) {
  const { marketTrend = null } = context;
  const metrics = getSignalMetrics(stockData, context);
  if (metrics.rsi == null || !metrics.levels) {
    return formatBaseSignal(stockData, marketTrend, metrics, false, 'insufficient_rsi_data', 'breakout');
  }

  const closes = stockData.closes;
  const highs = stockData.highs;
  const recentResistance = Math.max(...highs.slice(-20, -1));
  const breakout = closes[closes.length - 1] > recentResistance;
  const momentumRsi = metrics.rsi >= 50 && metrics.rsi <= 80;
  const marketSupports = marketTrend ? marketTrend.regime === 'breakout' || marketTrend.regime === 'trending' : true;
  const volumeRatioOk = metrics.volumeRatio != null && metrics.volumeRatio >= 1.0;
  const goodRiskReward = metrics.riskReward >= config.minRiskReward;
  const edgeCheck = applyEdgeFilters(metrics, 'long');
  const shouldBuy = breakout && momentumRsi && volumeRatioOk && marketSupports && goodRiskReward && edgeCheck.pass;
  const reason = shouldBuy ? 'breakout_confirmed' : (
    !marketSupports ? 'market_regime_not_breakout' :
      !breakout ? 'no_breakout' :
        !momentumRsi ? 'breakout_momentum_weak' :
          !volumeRatioOk ? 'volume_ratio_below_1.0' :
            !goodRiskReward ? 'insufficient_risk_reward' :
              !edgeCheck.pass ? edgeCheck.rejectReason : 'no_signal'
  );

  const signal = formatBaseSignal(stockData, marketTrend, metrics, shouldBuy, reason, 'breakout');
  signal.breakoutLevel = rounded(recentResistance);
  return signal;
}

export function generateTrendFollowingSignal(stockData, context = {}) {
  const { marketTrend = null } = context;
  const metrics = getSignalMetrics(stockData, context);
  if (metrics.rsi == null || !metrics.levels) {
    return formatBaseSignal(stockData, marketTrend, metrics, false, 'insufficient_rsi_data', 'trend_following');
  }

  const ema50Series = calculateEMA(stockData.closes, 50);
  const ema200Series = calculateEMA(stockData.closes, 200);
  if (ema50Series.length === 0 || ema200Series.length === 0) {
    return formatBaseSignal(stockData, marketTrend, metrics, false, 'insufficient_ema_data', 'trend_following');
  }

  const ema50 = ema50Series[ema50Series.length - 1];
  const ema200 = ema200Series[ema200Series.length - 1];
  const bullishTrend = stockData.price > ema50 && ema50 > ema200;
  const pullbackNearEma50 = stockData.price <= ema50 * 1.03 && stockData.price >= ema50 * 0.97;
  const momentumHealthy = metrics.rsi >= 30 && metrics.rsi <= 45;
  const marketSupports = marketTrend ? marketTrend.regime === 'trending' || marketTrend.regime === 'breakout' : true;
  const volumeRatioOk = metrics.volumeRatio != null && metrics.volumeRatio >= 0.7;
  const goodRiskReward = metrics.riskReward >= config.minRiskReward;
  const edgeCheck = applyEdgeFilters(metrics, 'long');
  const shouldBuy = bullishTrend && pullbackNearEma50 && momentumHealthy && marketSupports && volumeRatioOk && goodRiskReward && edgeCheck.pass;
  const reason = shouldBuy ? 'trend_pullback_entry' : (
    !marketSupports ? 'market_regime_not_trending' :
      !bullishTrend ? 'ema_trend_filter' :
        !pullbackNearEma50 ? 'not_pullback_zone' :
          !momentumHealthy ? 'trend_momentum_weak' :
            !volumeRatioOk ? 'volume_ratio_below_avg' :
              !goodRiskReward ? 'insufficient_risk_reward' :
                !edgeCheck.pass ? edgeCheck.rejectReason : 'no_signal'
  );

  const signal = formatBaseSignal(stockData, marketTrend, metrics, shouldBuy, reason, 'trend_following');
  signal.ema50 = rounded(ema50);
  signal.ema200 = rounded(ema200);
  return signal;
}

export function generateShortSignal(stockData, context = {}) {
  const { marketTrend = null } = context;
  const metrics = getSignalMetrics(stockData, context);
  if (metrics.rsi == null || !metrics.levels) {
    return formatBaseSignal(stockData, marketTrend, metrics, false, 'insufficient_rsi_data', 'short_simple', 'short');
  }

  const ema50Series = calculateEMA(stockData.closes, 50);
  const ema50 = ema50Series.length > 0 ? ema50Series[ema50Series.length - 1] : null;

  const belowEma50 = ema50 != null && stockData.price < ema50;
  const rsiInZone = metrics.rsi >= 45 && metrics.rsi <= 65;
  const nearResistance = metrics.levels.resistanceLevel > 0 &&
    stockData.price >= metrics.levels.resistanceLevel * 0.97;
  const goodRR = metrics.shortRiskReward >= 1.5;

  const shouldBuy = belowEma50 && rsiInZone && nearResistance && goodRR;

  let reason = 'no_signal';
  if (!belowEma50) reason = 'price_above_ema50';
  else if (!rsiInZone) reason = 'rsi_out_of_short_zone';
  else if (!nearResistance) reason = 'not_near_resistance';
  else if (!goodRR) reason = 'insufficient_risk_reward';
  else reason = 'valid_short_setup';

  const signal = formatBaseSignal(stockData, marketTrend, metrics, shouldBuy, reason, 'short_simple', 'short');
  signal.confidenceScore = scoreSignal(signal);
  signal.marketRegime = marketTrend?.regime ?? null;
  if (ema50 != null) signal.ema50 = rounded(ema50);
  return signal;
}

export function generateShortBreakdownSignal(stockData, context = {}) {
  const { marketTrend = null } = context;
  const metrics = getSignalMetrics(stockData, context);
  if (metrics.rsi == null || !metrics.levels) {
    return formatBaseSignal(stockData, marketTrend, metrics, false, 'insufficient_rsi_data', 'short_breakdown', 'short');
  }

  const lows = stockData.lows;
  const closes = stockData.closes;
  const recentSupport = Math.min(...lows.slice(-20, -1));
  const breakdown = closes[closes.length - 1] < recentSupport;
  const rsiInZone = metrics.rsi >= 25 && metrics.rsi <= 45;
  const volumeOk = metrics.volumeRatio != null && metrics.volumeRatio >= 1.2;
  const goodRR = metrics.shortRiskReward >= 1.5;

  const shouldBuy = breakdown && rsiInZone && volumeOk && goodRR;

  let reason = 'no_signal';
  if (!breakdown) reason = 'no_breakdown';
  else if (!rsiInZone) reason = 'rsi_out_of_short_zone';
  else if (!volumeOk) reason = 'volume_too_low';
  else if (!goodRR) reason = 'insufficient_risk_reward';
  else reason = 'valid_short_breakdown';

  const signal = formatBaseSignal(stockData, marketTrend, metrics, shouldBuy, reason, 'short_breakdown', 'short');
  signal.confidenceScore = scoreSignal(signal);
  signal.marketRegime = marketTrend?.regime ?? null;
  signal.breakdownLevel = rounded(recentSupport);
  return signal;
}

export function generateShortRallyFadeSignal(stockData, context = {}) {
  const { marketTrend = null } = context;
  const metrics = getSignalMetrics(stockData, context);
  if (metrics.rsi == null || !metrics.levels) {
    return formatBaseSignal(stockData, marketTrend, metrics, false, 'insufficient_rsi_data', 'short_rally_fade', 'short');
  }

  const ema50Series = calculateEMA(stockData.closes, 50);
  const ema50 = ema50Series.length > 0 ? ema50Series[ema50Series.length - 1] : null;

  const rsiOverbought = metrics.rsi >= 60 && metrics.rsi <= 75;
  const nearResistance = metrics.levels.resistanceLevel > 0 &&
    stockData.price >= metrics.levels.resistanceLevel * 0.97;
  const belowEma50 = ema50 != null && ema50 > stockData.price * 0.97;
  const goodRR = metrics.shortRiskReward >= 1.5;

  const shouldBuy = rsiOverbought && nearResistance && belowEma50 && goodRR;

  let reason = 'no_signal';
  if (!rsiOverbought) reason = 'rsi_not_overbought';
  else if (!nearResistance) reason = 'not_near_resistance';
  else if (!belowEma50) reason = 'price_too_far_above_ema50';
  else if (!goodRR) reason = 'insufficient_risk_reward';
  else reason = 'valid_short_rally_fade';

  const signal = formatBaseSignal(stockData, marketTrend, metrics, shouldBuy, reason, 'short_rally_fade', 'short');
  signal.confidenceScore = scoreSignal(signal);
  signal.marketRegime = marketTrend?.regime ?? null;
  if (ema50 != null) signal.ema50 = rounded(ema50);
  return signal;
}

function scoreSignal(signal) {
  const rrScore = Math.min((signal.riskReward || 0) / 3, 1);
  const volumeScore = Math.min((signal.volumeRatio || 0) / 2, 1);
  const atrScore = Math.min((signal.atrPercent || 0) / 3, 1);
  const rsiScore = signal.rsi == null ? 0.5 : 1 - Math.min(Math.abs(signal.rsi - 50) / 50, 1);
  const confidence = (rrScore * 0.35 + volumeScore * 0.2 + atrScore * 0.2 + rsiScore * 0.25);
  return rounded(Math.max(0.1, Math.min(confidence, 1)));
}

export function generateSignal(stockData, context = {}) {
  const { marketTrend = null } = context;
  const strategySignals = [
    generateMeanReversionSignal(stockData, context),
    generateBreakoutSignal(stockData, context),
    generateTrendFollowingSignal(stockData, context),
  ];

  const eligible = strategySignals.filter((signal) => signal.shouldBuy);
  const selected = eligible.length > 0
    ? eligible.sort((a, b) => (b.riskReward || 0) - (a.riskReward || 0))[0]
    : strategySignals[0];

  selected.confidenceScore = scoreSignal(selected);
  selected.marketRegime = marketTrend?.regime ?? null;
  selected.strategyCandidates = strategySignals.map((signal) => ({
    strategy: signal.strategy,
    shouldBuy: signal.shouldBuy,
    reason: signal.reason,
  }));
  return selected;
}
