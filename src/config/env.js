import 'dotenv/config';

function requireEnvInLiveMode(key) {
  const value = process.env[key];
  const mode = process.env.MODE || 'log';
  if (mode === 'live' && !value) {
    throw new Error(`Missing required env var ${key} for live mode`);
  }
  return value || '';
}

export const config = Object.freeze({
  kiteEnabled: String(process.env.KITE_ENABLED || '').toLowerCase() === 'true',
  apiKey: requireEnvInLiveMode('API_KEY'),
  apiSecret: requireEnvInLiveMode('API_SECRET'),
  accessToken: requireEnvInLiveMode('ACCESS_TOKEN'),

  capital: Number(process.env.CAPITAL) || 50000,
  maxTrades: Number(process.env.MAX_TRADES) || 3,
  perTradeCapital: Number(process.env.PER_TRADE_CAPITAL) || 10000,
  riskPerTradePercent: Number(process.env.RISK_PER_TRADE_PERCENT) || 0.01,
  maxPortfolioRiskPercent: Number(process.env.MAX_PORTFOLIO_RISK_PERCENT) || 0.1,
  maxDrawdownPercent: Number(process.env.MAX_DRAWDOWN_PERCENT) || 0.08,
  drawdownPauseDays: Number(process.env.DRAWDOWN_PAUSE_DAYS) || 7,
  stopLossPercent: Number(process.env.STOP_LOSS_PERCENT) || 0.04,
  targetPercent: Number(process.env.TARGET_PERCENT) || 0.08,
  maxHoldDays: Number(process.env.MAX_HOLD_DAYS) || 20,
  minRiskReward: Number(process.env.MIN_RISK_REWARD) || 1.5,
  atrPeriod: Number(process.env.ATR_PERIOD) || 14,
  minAtrPercent: Number(process.env.MIN_ATR_PERCENT) || 1.2,
  relativeStrengthLookback: Number(process.env.RELATIVE_STRENGTH_LOOKBACK) || 20,
  volumeSpikeMultiplier: Number(process.env.VOLUME_SPIKE_MULTIPLIER) || 1.5,
  entryStartHourIST: Number(process.env.ENTRY_START_HOUR_IST) || 9,
  entryStartMinuteIST: Number(process.env.ENTRY_START_MINUTE_IST) || 25,
  killSwitch: String(process.env.STOP_ALL || '').toLowerCase() === 'true',
  automationMode: process.env.AUTOMATION_MODE || 'full-auto',
  entrySlippageBps: Number(process.env.ENTRY_SLIPPAGE_BPS) || 20,
  exitSlippageBps: Number(process.env.EXIT_SLIPPAGE_BPS) || 20,
  maxOrderRetries: Number(process.env.MAX_ORDER_RETRIES) || 3,
  maxSectorTrades: Number(process.env.MAX_SECTOR_TRADES) || 2,
  maxSectorCapitalPercent: Number(process.env.MAX_SECTOR_CAPITAL_PERCENT) || 0.3,
  maxCorrelation: Number(process.env.MAX_CORRELATION) || 0.8,
  minAvgVolume: Number(process.env.MIN_AVG_VOLUME) || 1000000,
  strategyWeightMeanReversion: Number(process.env.STRATEGY_WEIGHT_MEAN_REVERSION) || 0.34,
  strategyWeightBreakout: Number(process.env.STRATEGY_WEIGHT_BREAKOUT) || 0.33,
  strategyWeightTrend: Number(process.env.STRATEGY_WEIGHT_TREND) || 0.33,
  useDynamicStrategyWeights: String(process.env.USE_DYNAMIC_STRATEGY_WEIGHTS || '').toLowerCase() === 'true',
  useKellySizing: String(process.env.USE_KELLY_SIZING || '').toLowerCase() === 'true',
  kellyFractionCap: Number(process.env.KELLY_FRACTION_CAP) || 0.25,
  counterTrendSizeMultiplier: Number(process.env.COUNTER_TREND_SIZE_MULTIPLIER) || 0.25,
  shortSystemEnabled: String(process.env.SHORT_SYSTEM_ENABLED || '').toLowerCase() === 'true',
  trailingStopEnabled: String(process.env.TRAILING_STOP_ENABLED || 'true').toLowerCase() === 'true',
  trailingStopActivationR: Number(process.env.TRAILING_STOP_ACTIVATION_R) || 1.0,
  trailingStopBreakevenR: Number(process.env.TRAILING_STOP_BREAKEVEN_R) || 1.5,
  trailingStopAtrMultiplier: Number(process.env.TRAILING_STOP_ATR_MULTIPLIER) || 2.0,
  trailingStopMinDays: Number(process.env.TRAILING_STOP_MIN_DAYS) || 2,
  tradeCostFixed: Number(process.env.TRADE_COST_FIXED) || 40,
  tradeCostPercent: Number(process.env.TRADE_COST_PERCENT) || 0.0003,
  edgeRollingWindow: Number(process.env.EDGE_ROLLING_WINDOW) || 20,
  edgeAutoDisableThreshold: Number(process.env.EDGE_AUTO_DISABLE_THRESHOLD) || -500,

  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  mode: process.env.MODE || 'log',
});
