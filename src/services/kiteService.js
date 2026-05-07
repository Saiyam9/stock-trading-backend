import { KiteConnect } from 'kiteconnect';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { recordApiFailure, recordLatency } from './healthService.js';

let kite = null;
let sessionValid = false;

export function getKite() {
  if (!config.kiteEnabled) return null;
  if (!kite) {
    if (!config.apiKey) {
      logger.warn('Kite API key not configured');
      return null;
    }
    kite = new KiteConnect({ api_key: config.apiKey });
    if (config.accessToken) {
      kite.setAccessToken(config.accessToken);
      sessionValid = true;
    }
  }
  return kite;
}

export function isKiteAvailable() {
  if (!config.kiteEnabled || !config.apiKey || !config.accessToken) return false;
  getKite();
  return sessionValid;
}

export function setAccessToken(token) {
  const k = getKite();
  if (k && token) {
    k.setAccessToken(token);
    sessionValid = true;
    logger.info('Kite access token updated');
  }
}

export function invalidateSession() {
  sessionValid = false;
  logger.warn('Kite session invalidated');
}

export async function validateSession() {
  const k = getKite();
  if (!k || !config.accessToken) return false;

  try {
    const start = Date.now();
    const profile = await k.getProfile();
    recordLatency(Date.now() - start);
    sessionValid = true;
    logger.info(`Kite session valid: ${profile.user_name} (${profile.user_id})`);
    return true;
  } catch (err) {
    sessionValid = false;
    recordApiFailure(`kite_session: ${err.message}`);
    logger.error(`Kite session invalid: ${err.message}`);
    return false;
  }
}

export async function getLiveQuotes(symbols) {
  const k = getKite();
  if (!k || !sessionValid) return null;

  const nseSymbols = symbols.map((s) => `NSE:${s}`);
  try {
    const start = Date.now();
    const quotes = await k.getQuote(nseSymbols);
    recordLatency(Date.now() - start);

    const result = {};
    for (const symbol of symbols) {
      const key = `NSE:${symbol}`;
      if (quotes[key]) {
        const q = quotes[key];
        result[symbol] = {
          price: q.last_price,
          open: q.ohlc.open,
          high: q.ohlc.high,
          low: q.ohlc.low,
          close: q.ohlc.close,
          volume: q.volume,
          timestamp: q.last_trade_time || new Date().toISOString(),
        };
      }
    }
    return result;
  } catch (err) {
    recordApiFailure(`kite_quotes: ${err.message}`);
    logger.error(`Failed to fetch live quotes: ${err.message}`);
    if (err.message?.includes('TokenException') || err.status === 403) {
      invalidateSession();
    }
    return null;
  }
}

export async function getLivePrice(symbol) {
  const quotes = await getLiveQuotes([symbol]);
  return quotes?.[symbol]?.price ?? null;
}

export async function generateLoginUrl() {
  const k = getKite();
  if (!k) return null;
  return k.getLoginURL();
}

export async function generateSession(requestToken) {
  const k = getKite();
  if (!k || !config.apiSecret) return null;

  try {
    const session = await k.generateSession(requestToken, config.apiSecret);
    setAccessToken(session.access_token);
    logger.info(`New Kite session generated, expires: ${session.login_time}`);
    return session;
  } catch (err) {
    logger.error(`Failed to generate Kite session: ${err.message}`);
    return null;
  }
}
