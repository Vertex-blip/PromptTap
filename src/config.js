import { resolve } from 'node:path';

export function readConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  const aiDailyLimit = Number(env.AI_DAILY_LIMIT || 250);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  if (!Number.isInteger(aiDailyLimit) || aiDailyLimit < 1) throw new Error('AI_DAILY_LIMIT must be a positive integer.');
  const production = env.NODE_ENV === 'production';
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || '';
  const miniAppUrl = env.MINI_APP_URL?.trim() || '';
  if (token && !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('TELEGRAM_BOT_TOKEN format is invalid.');
  if (miniAppUrl && new URL(miniAppUrl).protocol !== 'https:') throw new Error('MINI_APP_URL requires HTTPS.');
  if (production && !token) throw new Error('Production requires TELEGRAM_BOT_TOKEN.');
  return {
    port, production, token, miniAppUrl, aiDailyLimit,
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    trustProxy: env.TRUST_PROXY?.trim() || false,
    dataDir: resolve(env.DATA_DIR || 'data'),
    aiKey: env.AI_API_KEY?.trim() || '',
    aiModel: env.AI_MODEL?.trim() || '',
    aiBaseUrl: env.AI_BASE_URL?.trim() || 'https://api.openai.com/v1',
  };
}
