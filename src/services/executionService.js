import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { addTrade, closeTrade } from './tradeService.js';
import { sendAlert } from './alertService.js';
import { formatINR } from '../utils/helpers.js';
import {
  recordLatency,
  recordOrderFailure,
  recordOrderRetry,
} from './healthService.js';
import { getKite } from './kiteService.js';

function applyEntrySlippage(price) {
  return Math.round(price * (1 + config.entrySlippageBps / 10000) * 100) / 100;
}

function applyExitSlippage(price) {
  return Math.round(price * (1 - config.exitSlippageBps / 10000) * 100) / 100;
}

async function withOrderRetry(fn, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= config.maxOrderRetries; attempt++) {
    const startedAt = Date.now();
    try {
      const result = await fn();
      recordLatency(Date.now() - startedAt);
      return result;
    } catch (error) {
      lastError = error;
      recordOrderFailure(`${label}: ${error.message}`);
      if (attempt < config.maxOrderRetries) {
        recordOrderRetry();
        logger.warn(`${label} failed (attempt ${attempt}), retrying...`);
      }
    }
  }
  throw lastError;
}

export async function placeTrade(symbol, qty, price, metadata = {}) {
  const direction = metadata.direction ?? 'long';
  const isShort = direction === 'short';
  const slippageMultiplier = isShort ? -1 : 1;
  const actualEntryPrice = Math.round(price * (1 + slippageMultiplier * config.entrySlippageBps / 10000) * 100) / 100;
  const stopLoss = isShort
    ? Math.round(actualEntryPrice * (1 + config.stopLossPercent) * 100) / 100
    : Math.round(actualEntryPrice * (1 - config.stopLossPercent) * 100) / 100;
  const target = isShort
    ? Math.round(actualEntryPrice * (1 - config.targetPercent) * 100) / 100
    : Math.round(actualEntryPrice * (1 + config.targetPercent) * 100) / 100;
  const action = isShort ? 'SHORT' : 'BUY';
  const txnType = isShort ? 'SELL' : 'BUY';
  const product = isShort ? 'MIS' : 'CNC';

  if (config.mode === 'log') {
    logger.info(
      `[LOG MODE] Would ${action} ${symbol} | Qty: ${qty} | Signal: ₹${price} | EntryWithSlippage: ₹${actualEntryPrice} | SL: ₹${stopLoss} | Target: ₹${target}`
    );
    await sendAlert(
      `📊 SIGNAL: ${action} ${symbol}\nQty: ${qty}\nPrice: ${formatINR(actualEntryPrice)}\nSL: ${formatINR(stopLoss)}\nTarget: ${formatINR(target)}`
    );
    return;
  }

  if (config.mode === 'paper') {
    const trade = addTrade({
      symbol,
      direction,
      qty,
      intendedQty: qty,
      filledQty: qty,
      entryPrice: actualEntryPrice,
      stopLoss,
      target,
      signalTag: metadata.signalTag ?? null,
      marketCondition: metadata.marketCondition ?? null,
    });
    await sendAlert(
      `📈 PAPER TRADE: ${action} ${symbol}\nQty: ${qty}\nPrice: ${formatINR(actualEntryPrice)}\nSL: ${formatINR(stopLoss)}\nTarget: ${formatINR(target)}`
    );
    return trade;
  }

  if (!config.kiteEnabled) {
    logger.error(`Live mode requires KITE_ENABLED=true. Cannot place order for ${symbol}.`);
    await sendAlert(`❌ ORDER BLOCKED: ${action} ${symbol} — Kite is not enabled`);
    return null;
  }

  try {
    const k = getKite();
    if (!k) {
      throw new Error('Kite client unavailable — check API_KEY and ACCESS_TOKEN');
    }
    const order = await withOrderRetry(() => k.placeOrder('regular', {
      exchange: 'NSE',
      tradingsymbol: symbol,
      transaction_type: txnType,
      quantity: qty,
      product,
      order_type: 'LIMIT',
      price: actualEntryPrice,
    }), `${action} ${symbol}`);
    const filledQty = Number(order?.filled_quantity || qty);
    if (filledQty <= 0) {
      logger.warn(`${symbol}: order returned zero filled quantity`);
      return null;
    }

    logger.info(`Live ${action} order placed for ${symbol}: ${JSON.stringify(order)}`);

    const trade = addTrade({
      symbol,
      direction,
      qty: filledQty,
      intendedQty: qty,
      filledQty,
      entryPrice: actualEntryPrice,
      stopLoss,
      target,
      signalTag: metadata.signalTag ?? null,
      marketCondition: metadata.marketCondition ?? null,
    });
    await placeStopLoss(symbol, filledQty, stopLoss, direction);
    await placeTarget(symbol, filledQty, target, direction);

    await sendAlert(
      `🚀 LIVE TRADE: ${action} ${symbol}\nQty: ${filledQty}/${qty}\nPrice: ${formatINR(actualEntryPrice)}\nSL: ${formatINR(stopLoss)}\nTarget: ${formatINR(target)}\nOrder: ${order.order_id}`
    );

    return trade;
  } catch (err) {
    logger.error(`Failed to place ${action} order for ${symbol}: ${err.message}`);
    await sendAlert(`❌ ORDER FAILED: ${action} ${symbol} - ${err.message}`);
    throw err;
  }
}

export async function placeStopLoss(symbol, qty, stopPrice, direction = 'long') {
  if (config.mode !== 'live') return;
  const isShort = direction === 'short';
  const txnType = isShort ? 'BUY' : 'SELL';
  const product = isShort ? 'MIS' : 'CNC';

  try {
    const k = getKite();
    const order = await withOrderRetry(() => k.placeOrder('regular', {
      exchange: 'NSE',
      tradingsymbol: symbol,
      transaction_type: txnType,
      quantity: qty,
      product,
      order_type: 'SL',
      trigger_price: stopPrice,
      price: stopPrice,
    }), `SL ${symbol}`);
    logger.info(`SL order placed for ${symbol} at ₹${stopPrice}: ${JSON.stringify(order)}`);
  } catch (err) {
    logger.error(`Failed to place SL order for ${symbol}: ${err.message}`);
  }
}

export async function placeTarget(symbol, qty, targetPrice, direction = 'long') {
  if (config.mode !== 'live') return;
  const isShort = direction === 'short';
  const txnType = isShort ? 'BUY' : 'SELL';
  const product = isShort ? 'MIS' : 'CNC';

  try {
    const k = getKite();
    const order = await withOrderRetry(() => k.placeOrder('regular', {
      exchange: 'NSE',
      tradingsymbol: symbol,
      transaction_type: txnType,
      quantity: qty,
      product,
      order_type: 'LIMIT',
      price: targetPrice,
    }), `TARGET ${symbol}`);
    logger.info(
      `Target order placed for ${symbol} at ₹${targetPrice}: ${JSON.stringify(order)}`
    );
  } catch (err) {
    logger.error(`Failed to place target order for ${symbol}: ${err.message}`);
  }
}

export async function exitTrade(trade, currentPrice, reason) {
  const isShort = trade.direction === 'short';
  const slippageDir = isShort ? 1 : -1;
  const actualExitPrice = Math.round(currentPrice * (1 + slippageDir * config.exitSlippageBps / 10000) * 100) / 100;
  const txnType = isShort ? 'BUY' : 'SELL';
  const product = isShort ? 'MIS' : 'CNC';

  if (config.mode === 'log') {
    logger.info(
      `[LOG MODE] Would EXIT ${isShort ? 'SHORT' : 'LONG'} ${trade.symbol} | Reason: ${reason} | Price: ₹${actualExitPrice}`
    );
    return;
  }

  if (config.mode === 'paper') {
    const closed = closeTrade(trade.id, actualExitPrice, reason, {
      slippageApplied: true,
      exitSlippageBps: config.exitSlippageBps,
    });
    if (closed) {
      await sendAlert(
        `📉 PAPER EXIT: ${trade.symbol} (${isShort ? 'SHORT' : 'LONG'})\nReason: ${reason}\nEntry: ${formatINR(trade.entryPrice)}\nExit: ${formatINR(actualExitPrice)}\nPnL: ${formatINR(closed.pnl)}`
      );
    }
    return closed;
  }

  if (!config.kiteEnabled) {
    logger.error(`Live mode requires KITE_ENABLED=true. Cannot exit ${trade.symbol}.`);
    await sendAlert(`❌ EXIT BLOCKED: ${trade.symbol} — Kite is not enabled`);
    return null;
  }

  try {
    const k = getKite();
    if (!k) {
      throw new Error('Kite client unavailable — check API_KEY and ACCESS_TOKEN');
    }
    const order = await withOrderRetry(() => k.placeOrder('regular', {
      exchange: 'NSE',
      tradingsymbol: trade.symbol,
      transaction_type: txnType,
      quantity: trade.qty,
      product,
      order_type: 'MARKET',
    }), `EXIT ${trade.symbol}`);

    const closed = closeTrade(trade.id, actualExitPrice, reason, {
      slippageApplied: true,
      exitSlippageBps: config.exitSlippageBps,
      orderId: order.order_id,
    });
    logger.info(`Live ${txnType} order for ${trade.symbol}: ${JSON.stringify(order)}`);

    if (closed) {
      await sendAlert(
        `🔴 LIVE EXIT: ${trade.symbol} (${isShort ? 'SHORT' : 'LONG'})\nReason: ${reason}\nEntry: ${formatINR(trade.entryPrice)}\nExit: ${formatINR(actualExitPrice)}\nPnL: ${formatINR(closed.pnl)}\nOrder: ${order.order_id}`
      );
    }
    return closed;
  } catch (err) {
    logger.error(`Failed to exit ${trade.symbol}: ${err.message}`);
    await sendAlert(`❌ EXIT FAILED: ${trade.symbol} - ${err.message}`);
    throw err;
  }
}
