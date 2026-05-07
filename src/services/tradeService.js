import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADES_FILE = path.resolve(__dirname, '../../data/trades.json');

function readTrades() {
  try {
    const data = fs.readFileSync(TRADES_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function writeTrades(trades) {
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2), 'utf-8');
}

export function getOpenTrades() {
  return readTrades().filter((t) => t.status === 'open');
}

export function getAllTrades() {
  return readTrades();
}

export function addTrade(trade) {
  const trades = readTrades();
  const record = {
    id: Date.now().toString(36),
    ...trade,
    status: 'open',
    entryDate: new Date().toISOString(),
    exitDate: null,
    exitPrice: null,
    pnl: null,
    exitReason: null,
    intendedQty: trade.intendedQty ?? trade.qty,
    filledQty: trade.filledQty ?? trade.qty,
    signalTag: trade.signalTag ?? null,
    marketCondition: trade.marketCondition ?? null,
    journal: [{
      event: 'entry',
      timestamp: new Date().toISOString(),
      why: trade.signalTag
        ? `${trade.signalTag.strategy}: ${trade.signalTag.reason} | RSI=${trade.signalTag.rsi} RR=${trade.signalTag.riskReward} ATR%=${trade.signalTag.atrPercent}`
        : 'manual entry',
      regime: trade.marketCondition?.regime ?? 'unknown',
    }],
    trailingHistory: [],
  };
  trades.push(record);
  writeTrades(trades);
  logger.info(
    `Trade opened: ${record.symbol} | Qty: ${record.qty} | Entry: ₹${record.entryPrice} | SL: ₹${record.stopLoss} | Target: ₹${record.target}`
  );
  return record;
}

export function closeTrade(tradeId, exitPrice, exitReason, executionMeta = null) {
  const trades = readTrades();
  const trade = trades.find((t) => t.id === tradeId);
  if (!trade) {
    logger.error(`Trade ${tradeId} not found`);
    return null;
  }

  trade.status = 'closed';
  trade.exitDate = new Date().toISOString();
  trade.exitPrice = exitPrice;
  trade.pnl = (exitPrice - trade.entryPrice) * trade.qty;
  trade.exitReason = exitReason;
  if (executionMeta) {
    trade.executionMeta = executionMeta;
  }
  trade.journal = trade.journal ?? [];
  const pnlPercent = trade.entryPrice > 0
    ? ((exitPrice - trade.entryPrice) / trade.entryPrice * 100).toFixed(2)
    : '0';
  trade.journal.push({
    event: 'exit',
    timestamp: trade.exitDate,
    reason: exitReason,
    pnlPercent,
    outcome: trade.pnl > 0 ? 'win' : 'loss',
    why: trade.pnl > 0
      ? `Target/trail hit after ${exitReason}. PnL: ${pnlPercent}%`
      : `Stopped out via ${exitReason}. PnL: ${pnlPercent}%`,
  });

  writeTrades(trades);
  logger.info(
    `Trade closed: ${trade.symbol} | Reason: ${exitReason} | PnL: ₹${trade.pnl.toFixed(2)}`
  );
  return trade;
}

export function updateTradeStopLoss(tradeId, newStopLoss) {
  const trades = readTrades();
  const trade = trades.find((t) => t.id === tradeId);
  if (!trade) return null;
  trade.stopLoss = newStopLoss;
  trade.trailingHistory = trade.trailingHistory ?? [];
  trade.trailingHistory.push({
    stopLoss: newStopLoss,
    timestamp: new Date().toISOString(),
  });
  writeTrades(trades);
  return trade;
}

export function addJournalEntry(tradeId, entry) {
  const trades = readTrades();
  const trade = trades.find((t) => t.id === tradeId);
  if (!trade) return null;
  trade.journal = trade.journal ?? [];
  trade.journal.push({
    ...entry,
    timestamp: new Date().toISOString(),
  });
  writeTrades(trades);
  return trade;
}

export function getEdgeMetrics(windowSize = 20) {
  const closed = readTrades()
    .filter((t) => t.status === 'closed')
    .sort((a, b) => new Date(a.exitDate) - new Date(b.exitDate));

  const recent = closed.slice(-windowSize);
  if (recent.length === 0) {
    return {
      sampleSize: 0,
      rollingWinRate: 0,
      rollingExpectancy: 0,
      rollingDrawdownTrend: 'flat',
    };
  }

  const wins = recent.filter((t) => t.pnl > 0);
  const losses = recent.filter((t) => t.pnl <= 0);
  const winRate = wins.length / recent.length;
  const lossRate = losses.length / recent.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const expectancy = winRate * avgWin - lossRate * avgLoss;

  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const halfPoint = Math.floor(recent.length / 2);
  let firstHalfDd = 0;
  let secondHalfDd = 0;

  recent.forEach((t, idx) => {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    maxDd = Math.max(maxDd, dd);
    if (idx < halfPoint) firstHalfDd = Math.max(firstHalfDd, dd);
    else secondHalfDd = Math.max(secondHalfDd, dd);
  });

  const drawdownTrend = secondHalfDd > firstHalfDd * 1.3 ? 'worsening'
    : secondHalfDd < firstHalfDd * 0.7 ? 'improving'
      : 'flat';

  const firstHalfWins = recent.slice(0, halfPoint).filter((t) => t.pnl > 0).length;
  const secondHalfWins = recent.slice(halfPoint).filter((t) => t.pnl > 0).length;
  const firstHalfWinRate = halfPoint > 0 ? firstHalfWins / halfPoint : 0;
  const secondHalfLen = recent.length - halfPoint;
  const secondHalfWinRate = secondHalfLen > 0 ? secondHalfWins / secondHalfLen : 0;
  const winRateFalling = secondHalfWinRate < firstHalfWinRate * 0.8;

  const shouldDisable = expectancy < 0 && winRateFalling && drawdownTrend === 'worsening';

  return {
    sampleSize: recent.length,
    rollingWinRate: Math.round(winRate * 10000) / 100,
    rollingExpectancy: Math.round(expectancy * 100) / 100,
    rollingDrawdownTrend: drawdownTrend,
    maxDrawdownPercent: Math.round(maxDd * 10000) / 100,
    winRateFalling,
    shouldDisable,
  };
}

export function getPerformanceAnalytics() {
  const trades = readTrades().filter((trade) => trade.status === 'closed');
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl <= 0);
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const lossRate = trades.length > 0 ? losses.length / trades.length : 0;
  const avgWin = wins.length > 0
    ? wins.reduce((sum, trade) => sum + trade.pnl, 0) / wins.length
    : 0;
  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0) / losses.length)
    : 0;
  const expectancy = winRate * avgWin - lossRate * avgLoss;

  let equity = 0;
  const equityCurve = trades
    .sort((a, b) => new Date(a.exitDate) - new Date(b.exitDate))
    .map((trade) => {
      equity += trade.pnl;
      return {
        date: trade.exitDate,
        equity,
      };
    });

  const clusters = {};
  for (const trade of trades) {
    const rsiBucket = trade.signalTag?.rsi == null
      ? 'unknown'
      : trade.signalTag.rsi < 35
        ? 'rsi_lt_35'
        : trade.signalTag.rsi <= 50
          ? 'rsi_35_50'
          : 'rsi_gt_50';
    const atrBucket = trade.signalTag?.atrPercent == null
      ? 'atr_unknown'
      : trade.signalTag.atrPercent < 1.2
        ? 'atr_low'
        : trade.signalTag.atrPercent <= 2
          ? 'atr_medium'
          : 'atr_high';
    const regime = trade.marketCondition?.regime || 'unknown_regime';
    const key = `${rsiBucket}|${atrBucket}|${regime}`;
    if (!clusters[key]) {
      clusters[key] = { count: 0, pnl: 0, wins: 0 };
    }
    clusters[key].count += 1;
    clusters[key].pnl += trade.pnl || 0;
    if ((trade.pnl || 0) > 0) clusters[key].wins += 1;
  }

  return {
    totalTrades: trades.length,
    winRate: Math.round(winRate * 10000) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    expectancy: Math.round(expectancy * 100) / 100,
    equityCurve,
    clusters,
  };
}
