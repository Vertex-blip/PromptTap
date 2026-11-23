import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readConfig } from './config.js';
import { Store } from './store.js';
import { createAI } from './ai.js';
import { createService } from './service.js';
import { createApp } from './server.js';
import { createBot } from './bot.js';
import { run } from '@grammyjs/runner';

const config = readConfig();
let catalog;
try { catalog = JSON.parse(await readFile(join(config.dataDir, 'catalog.json'), 'utf8')); }
catch { console.error('Catalog missing or invalid. Run npm run import before starting PromptTap.'); process.exit(1); }
const store = new Store(join(config.dataDir, 'prompttap.sqlite'));
const service = createService({ catalog, ai: createAI(config, store), config });
const app = createApp({ config, service, store });
let bot;
let runner;
let stopping = false;
const server = app.listen(config.port, config.host, () => {
  console.log(`PromptTap preview http://${config.host}:${config.port}`);
  console.log(`Catalog: ${service.meta().total} available prompts. AI: ${service.meta().aiConfigured ? 'configured' : 'template mode'}.`);
});
server.on('error', error => {
  console.error('Server failed', { code: error.code });
  void shutdown(1);
});

if (config.token) {
  bot = createBot({ token: config.token, miniAppUrl: config.miniAppUrl, service, store });
  try {
    await bot.init();
    await bot.api.setMyCommands([
      { command: 'start', description: 'PromptTap ашу · Открыть · Open' },
      { command: 'search', description: 'Іздеу · Поиск · Search' },
      { command: 'saved', description: 'Таңдаулы · Избранное · Saved' },
      { command: 'language', description: 'Тіл · Язык · Language' },
      { command: 'help', description: 'Көмек · Помощь · Help' },
    ]);
    if (config.miniAppUrl) await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'PromptTap', web_app: { url: config.miniAppUrl } } });
    runner = run(bot, {
      runner: { fetch: { allowed_updates: ['message', 'callback_query'] }, silent: true, maxRetryTime: 60000 },
      sink: { concurrency: 32 },
    });
    console.log(`Telegram connected @${bot.botInfo.username}`);
    runner.task()?.catch(error => {
      console.error('Telegram polling stopped', { type: error.name });
      shutdown(1);
    });
  } catch (error) {
    console.error('Telegram connection failed. Check token and network.', { type: error.name });
    await shutdown(1);
  }
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(code), 10000).unref();
  try {
    if (runner?.isRunning()) await runner.stop();
  } catch (error) {
    console.error('Telegram shutdown failed', { type: error.name });
  } finally {
    server.close(() => { clearTimeout(timeout); store.close(); process.exit(code); });
    server.closeIdleConnections();
  }
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
