import {
  generateBreakoutSignal,
  generateMeanReversionSignal,
  generateSignal,
  generateTrendFollowingSignal,
  generateShortBreakdownSignal,
  generateShortRallyFadeSignal,
  generateShortSignal,
} from '../services/signalService.js';
import { config } from '../config/env.js';

export function evaluateStock(stockData, context = {}) {
  const marketTrend = context.marketTrend;
  const regime = marketTrend?.regime;
  const isBullish = marketTrend?.isBullish ?? false;

  if (!config.shortSystemEnabled) {
    const longSignal = pickLongSignal(stockData, context, regime);
    return longSignal;
  }

  if (isBullish) {
    const longSignal = pickLongSignal(stockData, context, regime);
    if (longSignal.shouldBuy) return longSignal;

    const shortSignal = pickShortSignal(stockData, context, regime);
    if (shortSignal.shouldBuy) {
      shortSignal.isCounterTrend = true;
      return shortSignal;
    }
    return longSignal;
  }

  const shortSignal = pickShortSignal(stockData, context, regime);
  if (shortSignal.shouldBuy) return shortSignal;

  const longSignal = pickLongSignal(stockData, context, regime);
  if (longSignal.shouldBuy) {
    longSignal.isCounterTrend = true;
    return longSignal;
  }
  return shortSignal;
}

function pickLongSignal(stockData, context, regime) {
  if (regime === 'breakout') return generateBreakoutSignal(stockData, context);
  if (regime === 'trending') return generateTrendFollowingSignal(stockData, context);
  if (regime === 'sideways') return generateMeanReversionSignal(stockData, context);
  return generateSignal(stockData, context);
}

function pickShortSignal(stockData, context, regime) {
  const candidates = [
    generateShortSignal(stockData, context),
    generateShortBreakdownSignal(stockData, context),
    generateShortRallyFadeSignal(stockData, context),
  ];
  const eligible = candidates.filter((s) => s.shouldBuy);
  if (eligible.length === 0) return candidates[0];
  return eligible.sort((a, b) => (b.riskReward || 0) - (a.riskReward || 0))[0];
}
