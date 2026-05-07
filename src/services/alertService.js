import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

let bot = null;

function getBot() {
  if (!bot && config.telegramToken) {
    bot = new TelegramBot(config.telegramToken);
  }
  return bot;
}

export async function sendAlert(message) {
  logger.info(`ALERT: ${message}`);

  const telegramBot = getBot();
  if (!telegramBot || !config.telegramChatId) {
    return;
  }

  try {
    await telegramBot.sendMessage(config.telegramChatId, message);
  } catch (err) {
    logger.error(`Telegram alert failed: ${err.message}`);
  }
}
