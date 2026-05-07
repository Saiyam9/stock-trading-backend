import YahooFinance from 'yahoo-finance2';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { recordApiFailure } from './healthService.js';
import { getLiveQuotes, isKiteAvailable } from './kiteService.js';
import { isMarketHours } from '../utils/helpers.js';

const yahooFinanceClient = new YahooFinance();

function roundPrice(value) {
  return Math.round(Number(value) * 100) / 100;
}

function normalizeYahooSymbol(symbol) {
  if (symbol.startsWith('^') || symbol.includes('.')) {
    return symbol;
  }

  return `${symbol}.NS`;
}

function buildHistoricalSeries(symbol, quotes) {
  const candles = quotes
    .filter((quote) => {
      return (
        quote.date &&
        quote.open != null &&
        quote.high != null &&
        quote.low != null &&
        quote.close != null
      );
    })
    .map((quote) => {
      return {
        date: new Date(quote.date).toISOString().split('T')[0],
        open: roundPrice(quote.open),
        high: roundPrice(quote.high),
        low: roundPrice(quote.low),
        close: roundPrice(quote.close),
        volume: Number(quote.volume || 0),
      };
    });

  if (candles.length === 0) {
    return null;
  }

  return {
    symbol,
    dates: candles.map((candle) => candle.date),
    opens: candles.map((candle) => candle.open),
    highs: candles.map((candle) => candle.high),
    lows: candles.map((candle) => candle.low),
    closes: candles.map((candle) => candle.close),
    volumes: candles.map((candle) => candle.volume),
    candles,
    price: candles[candles.length - 1].close,
  };
}

export async function getStockData(symbol, options = {}) {
  const {
    lookbackDays = 260,
    interval = '1d',
  } = options;

  try {
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - lookbackDays);

    const result = await yahooFinanceClient.chart(normalizeYahooSymbol(symbol), {
      period1: startDate.toISOString().split('T')[0],
      period2: now.toISOString().split('T')[0],
      interval,
    });

    const historicalSeries = buildHistoricalSeries(symbol, result.quotes || []);
    if (!historicalSeries) {
      logger.warn(`No data returned for ${symbol}`);
      return null;
    }

    return historicalSeries;
  } catch (error) {
    logger.error(`Failed to fetch data for ${symbol}: ${error.message}`);
    recordApiFailure(`data_${symbol}: ${error.message}`);
    return null;
  }
}

export async function getBenchmarkData(options = {}) {
  const { lookbackDays = 3000 } = options;
  return getStockData('^NSEI', { lookbackDays });
}

export async function getLivePrices(symbols) {
  if (config.kiteEnabled && isKiteAvailable() && isMarketHours()) {
    const quotes = await getLiveQuotes(symbols);
    if (quotes && Object.keys(quotes).length > 0) {
      return quotes;
    }
    logger.warn('Kite quotes failed, falling back to Yahoo');
  }

  const prices = {};
  for (const symbol of symbols) {
    try {
      const data = await getStockData(symbol, { lookbackDays: 5 });
      if (data) {
        prices[symbol] = { price: data.price, source: 'yahoo_daily' };
      }
    } catch {
      logger.warn(`Failed to get fallback price for ${symbol}`);
    }
  }
  return prices;
}

export async function getLivePrice(symbol) {
  const prices = await getLivePrices([symbol]);
  return prices[symbol]?.price ?? null;
}
