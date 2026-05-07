/**
 * RSI using Wilder's smoothing method (14-period default).
 * Returns an array of RSI values aligned to the input from index `period` onward.
 */
export function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return [];

  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] >= 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  const rsiValues = [];
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsiValues.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));

  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] >= 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    const currentRS = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiValues.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + currentRS));
  }

  return rsiValues;
}

export function calculateSMA(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) {
    return [];
  }

  const sma = [];
  let windowSum = 0;

  for (let i = 0; i < values.length; i++) {
    windowSum += values[i];

    if (i >= period) {
      windowSum -= values[i - period];
    }

    if (i >= period - 1) {
      sma.push(windowSum / period);
    }
  }

  return sma;
}

export function calculateEMA(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) {
    return [];
  }

  const multiplier = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const ema = [seed];
  for (let i = period; i < values.length; i++) {
    ema.push((values[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
  }
  return ema;
}

export function calculateATR(highs, lows, closes, period = 14) {
  if (
    !Array.isArray(highs) ||
    !Array.isArray(lows) ||
    !Array.isArray(closes) ||
    highs.length !== lows.length ||
    highs.length !== closes.length ||
    highs.length < period + 1
  ) {
    return [];
  }

  const trueRanges = [];
  for (let i = 1; i < highs.length; i++) {
    const highLow = highs[i] - lows[i];
    const highPrevClose = Math.abs(highs[i] - closes[i - 1]);
    const lowPrevClose = Math.abs(lows[i] - closes[i - 1]);
    trueRanges.push(Math.max(highLow, highPrevClose, lowPrevClose));
  }

  let atr = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const atrValues = [atr];
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    atrValues.push(atr);
  }
  return atrValues;
}

export function calculateReturnPercent(closes, lookback = 20) {
  if (!Array.isArray(closes) || closes.length <= lookback) return null;
  const current = closes[closes.length - 1];
  const prior = closes[closes.length - 1 - lookback];
  if (!prior) return null;
  return ((current - prior) / prior) * 100;
}

export function calculateADX(highs, lows, closes, period = 14) {
  if (
    !Array.isArray(highs) ||
    !Array.isArray(lows) ||
    !Array.isArray(closes) ||
    highs.length !== lows.length ||
    highs.length !== closes.length ||
    highs.length < period * 2
  ) {
    return [];
  }

  const trList = [];
  const plusDmList = [];
  const minusDmList = [];

  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;

    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );

    trList.push(tr);
    plusDmList.push(plusDm);
    minusDmList.push(minusDm);
  }

  let tr14 = trList.slice(0, period).reduce((sum, value) => sum + value, 0);
  let plus14 = plusDmList.slice(0, period).reduce((sum, value) => sum + value, 0);
  let minus14 = minusDmList.slice(0, period).reduce((sum, value) => sum + value, 0);

  const dx = [];
  for (let i = period; i < trList.length; i++) {
    tr14 = tr14 - tr14 / period + trList[i];
    plus14 = plus14 - plus14 / period + plusDmList[i];
    minus14 = minus14 - minus14 / period + minusDmList[i];

    const plusDI = (plus14 / tr14) * 100;
    const minusDI = (minus14 / tr14) * 100;
    const denominator = plusDI + minusDI;
    const currentDx = denominator === 0 ? 0 : (Math.abs(plusDI - minusDI) / denominator) * 100;
    dx.push(currentDx);
  }

  if (dx.length < period) return [];

  let adx = dx.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const adxSeries = [adx];
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
    adxSeries.push(adx);
  }

  return adxSeries;
}

export function calculateCorrelation(a, b, lookback = 60) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const n = Math.min(a.length, b.length, lookback);
  if (n < 10) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const meanX = x.reduce((sum, value) => sum + value, 0) / n;
  const meanY = y.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return numerator / Math.sqrt(varX * varY);
}

function roundPrice(value) {
  return Math.round(value * 100) / 100;
}

export function detectPivotPoints(
  highs,
  lows,
  leftBars = 3,
  rightBars = 3
) {
  const pivotHighs = [];
  const pivotLows = [];

  if (!Array.isArray(highs) || !Array.isArray(lows) || highs.length !== lows.length) {
    return { pivotHighs, pivotLows };
  }

  for (let i = leftBars; i < highs.length - rightBars; i++) {
    const high = highs[i];
    const low = lows[i];
    let isPivotHigh = true;
    let isPivotLow = true;

    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (highs[j] >= high) isPivotHigh = false;
      if (lows[j] <= low) isPivotLow = false;
      if (!isPivotHigh && !isPivotLow) break;
    }

    if (isPivotHigh) {
      pivotHighs.push({ index: i, price: high });
    }
    if (isPivotLow) {
      pivotLows.push({ index: i, price: low });
    }
  }

  return { pivotHighs, pivotLows };
}

function clusterPriceLevels(points, toleranceRatio, minTouches = 2) {
  if (points.length === 0) return [];

  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];

  for (const point of sorted) {
    const cluster = clusters.find((candidate) => {
      const tolerance = candidate.price * toleranceRatio;
      return Math.abs(candidate.price - point.price) <= tolerance;
    });

    if (!cluster) {
      clusters.push({
        price: point.price,
        touches: 1,
        firstIndex: point.index,
        lastIndex: point.index,
      });
      continue;
    }

    const totalTouches = cluster.touches + 1;
    cluster.price = (cluster.price * cluster.touches + point.price) / totalTouches;
    cluster.touches = totalTouches;
    cluster.firstIndex = Math.min(cluster.firstIndex, point.index);
    cluster.lastIndex = Math.max(cluster.lastIndex, point.index);
  }

  return clusters
    .filter((cluster) => cluster.touches >= minTouches)
    .sort((a, b) => b.touches - a.touches || b.lastIndex - a.lastIndex);
}

export function getSupportResistanceLevels(
  stockData,
  {
    lookback = 90,
    toleranceRatio = 0.008,
    minTouches = 2,
    pivotLeftBars = 3,
    pivotRightBars = 3,
  } = {}
) {
  const highs = stockData.highs.slice(-lookback);
  const lows = stockData.lows.slice(-lookback);
  const closes = stockData.closes.slice(-lookback);
  const currentPrice = stockData.price;

  if (highs.length < pivotLeftBars + pivotRightBars + 3) {
    const fallbackLowWindow = stockData.lows.slice(-20);
    const fallbackHighWindow = stockData.highs.slice(-20);
    const fallbackSupport = fallbackLowWindow.length ? Math.min(...fallbackLowWindow) : currentPrice;
    const fallbackResistance = fallbackHighWindow.length ? Math.max(...fallbackHighWindow) : currentPrice;
    return {
      supportLevel: fallbackSupport,
      resistanceLevel: fallbackResistance,
      supportTouches: 1,
      resistanceTouches: 1,
      method: 'fallback_20d_range',
    };
  }

  const { pivotHighs, pivotLows } = detectPivotPoints(
    highs,
    lows,
    pivotLeftBars,
    pivotRightBars
  );

  const supportClusters = clusterPriceLevels(pivotLows, toleranceRatio, minTouches);
  const resistanceClusters = clusterPriceLevels(pivotHighs, toleranceRatio, minTouches);

  const supportsBelowPrice = supportClusters.filter((level) => level.price <= currentPrice);
  const resistancesAbovePrice = resistanceClusters.filter((level) => level.price >= currentPrice);

  const bestSupport = supportsBelowPrice.sort((a, b) => b.price - a.price)[0];
  const bestResistance = resistancesAbovePrice.sort((a, b) => a.price - b.price)[0];

  return {
    supportLevel: roundPrice(bestSupport?.price ?? Math.min(...lows)),
    resistanceLevel: roundPrice(bestResistance?.price ?? Math.max(...highs)),
    supportTouches: bestSupport?.touches ?? 1,
    resistanceTouches: bestResistance?.touches ?? 1,
    method: supportClusters.length > 0 || resistanceClusters.length > 0
      ? 'pivot_clusters'
      : 'fallback_range',
    recentClose: closes[closes.length - 1],
  };
}

export function evaluateMarketTrend(benchmarkData) {
  if (!benchmarkData || benchmarkData.closes.length < 200) {
    return {
      isBullish: false,
      trendLabel: 'insufficient_data',
      reason: 'Not enough benchmark candles for trend detection',
      latestClose: benchmarkData?.price ?? null,
      sma50: null,
      sma200: null,
    };
  }

  const closes = benchmarkData.closes;
  const sma50Series = calculateSMA(closes, 50);
  const sma200Series = calculateSMA(closes, 200);
  const latestClose = closes[closes.length - 1];
  const sma50 = sma50Series[sma50Series.length - 1];
  const sma200 = sma200Series[sma200Series.length - 1];
  const spreadPercent = ((sma50 - sma200) / sma200) * 100;
  const slopeWindow = 10;
  const priorSma50 = sma50Series[sma50Series.length - 1 - slopeWindow];
  const sma50Slope = priorSma50 != null ? ((sma50 - priorSma50) / priorSma50) * 100 : 0;

  const isBullish = latestClose > sma200 && sma50 > sma200 && sma50Slope >= 0;
  const trendLabel = isBullish ? 'bullish' : 'bearish';
  const reason = isBullish
    ? 'Nifty 50 is above 200-SMA with positive medium-term slope'
    : 'Nifty 50 trend filter blocked entries in broad downtrend';

  return {
    isBullish,
    trendLabel,
    reason,
    latestClose: roundPrice(latestClose),
    sma50: roundPrice(sma50),
    sma200: roundPrice(sma200),
    spreadPercent: Math.round(spreadPercent * 100) / 100,
    sma50SlopePercent: Math.round(sma50Slope * 100) / 100,
  };
}

export function evaluateMarketRegime(benchmarkData) {
  const trend = evaluateMarketTrend(benchmarkData);
  if (!benchmarkData || benchmarkData.closes.length < 220) {
    return {
      ...trend,
      regime: 'unknown',
      adx: null,
      volatilityRegime: 'unknown',
    };
  }

  const atrSeries = calculateATR(benchmarkData.highs, benchmarkData.lows, benchmarkData.closes, 14);
  const adxSeries = calculateADX(benchmarkData.highs, benchmarkData.lows, benchmarkData.closes, 14);
  const latestAtr = atrSeries[atrSeries.length - 1] ?? null;
  const atrAverage = atrSeries.length > 20
    ? atrSeries.slice(-20).reduce((sum, value) => sum + value, 0) / 20
    : latestAtr;
  const latestAdx = adxSeries[adxSeries.length - 1] ?? null;
  const volatilityRegime = latestAtr != null && atrAverage != null && latestAtr > atrAverage * 1.1
    ? 'expanding'
    : 'normal';

  let regime = 'sideways';
  if (trend.isBullish && (latestAdx ?? 0) >= 22) {
    regime = volatilityRegime === 'expanding' ? 'breakout' : 'trending';
  } else if (!trend.isBullish && (latestAdx ?? 0) >= 22) {
    regime = 'risk_off';
  }

  return {
    ...trend,
    regime,
    adx: latestAdx == null ? null : roundPrice(latestAdx),
    volatilityRegime,
  };
}

/**
 * Checks if the current price is within `threshold` (default 2%) of
 * the lowest low in the last `lookback` days.
 */
export function isNearSupport(stockData, lookback = 20, threshold = 0.02) {
  const { lows, highs, price } = stockData;
  if (lows.length < lookback || highs.length < lookback) return false;

  const levels = getSupportResistanceLevels(stockData, { lookback: Math.max(lookback, 60) });
  const supportLevel = levels.supportLevel;
  return price <= supportLevel * (1 + threshold);
}
