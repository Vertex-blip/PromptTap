import test from 'node:test';
import assert from 'node:assert/strict';
import { createBot, escapeHtml, validMiniAppUrl } from '../src/bot.js';

const prompt = {
  id: 'abc123', title: 'Logo <design>', content: 'Create a logo for <brand> & describe it.',
  sources: ['archive.zip/design.txt'], language: 'en', category: 'design',
};

async function fixture(overrides = {}) {
  const users = new Map();
  const searches = new Map();
  const favorites = new Map();
  const calls = [];
  const adapted = [];
  let nextSearch = 0;
  let updateId = 0;
  const store = {
    getUser: (id) => users.get(id) || { language: 'kk', lastQuery: '' },
    setUser(id, patch) { users.set(id, { ...this.getUser(id), ...patch }); },
    saveSearch(id, query, results) {
      const searchId = String(++nextSearch);
      searches.set(searchId, { userId: id, query, results });
      return searchId;
    },
    getSearch: (searchId, id) => searches.get(searchId)?.userId === id ? searches.get(searchId) : null,
    toggleFavorite(id, promptId) {
      const entries = favorites.get(id) || new Set();
      if (entries.has(promptId)) entries.delete(promptId);
      else entries.add(promptId);
      favorites.set(id, entries);
      return entries.has(promptId);
    },
    listFavorites: (id) => [...(favorites.get(id) || [])],
    allowRequest: () => true,
    consume: () => true,
    ...overrides.store,
  };
  const service = {
    search: async () => ({ results: [{ ...prompt, description: 'Design & branding', score: 1, sourceCount: 1 }] }),
    getPrompt: async (id) => id === prompt.id ? prompt : null,
    adapt: async (args) => { adapted.push(args); return { text: `Task: ${args.query}`, mode: 'template', sourceIds: [] }; },
    meta: () => ({ total: 1 }),
    ...overrides.service,
  };
  const bot = createBot({ token: '123456:local-test-only', miniAppUrl: 'https://example.com/app', store, service });
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload });
    if (method === 'getMe') return { ok: true, result: { id: 123456, is_bot: true, first_name: 'PromptTap', username: 'PromptTapBot' } };
    if (method === 'sendMessage' || method === 'sendDocument') {
      return { ok: true, result: { message_id: calls.length, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text } };
    }
    return { ok: true, result: true };
  });
  await bot.init();
  calls.length = 0;
  const user = (id) => ({ id, is_bot: false, first_name: `User ${id}` });
  const message = async (text, id = 1) => {
    const command = text.match(/^\/\w+/)?.[0];
    await bot.handleUpdate({ update_id: ++updateId, message: {
      message_id: updateId, date: 0, from: user(id), chat: { id, type: 'private' }, text,
      ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}),
    } });
  };
  const callback = async (data, id = 1) => bot.handleUpdate({ update_id: ++updateId, callback_query: {
    id: `cb-${updateId}`, from: user(id), chat_instance: 'test', data,
    message: { message_id: 99, date: 0, chat: { id, type: 'private' } },
  } });
  return { bot, store, calls, adapted, searches, message, callback };
}

test('start provides localized welcome and HTTPS Mini App entry', async () => {
  const app = await fixture();
  await app.message('/start');
  const reply = app.calls.find((call) => call.method === 'sendMessage').payload;
  assert.match(reply.text, /PromptTap/);
  assert.match(reply.text, /Қандай тапсырма/);
  assert.equal(reply.reply_markup.inline_keyboard[0][0].web_app.url, 'https://example.com/app');
  await app.callback('lang:ru');
  await app.message('/start');
  assert.match(app.calls.at(-1).payload.text, /Для какой задачи/);
});

test('search result opens escaped original and adaptation retains its own query', async () => {
  const app = await fixture();
  await app.message('first logo request');
  await app.message('second logo request');
  await app.callback('pick:1:0');
  const reply = app.calls.at(-1).payload;
  assert.match(reply.text, /Logo &lt;design&gt;/);
  assert.match(reply.text, /&lt;brand&gt; &amp;/);
  await app.callback('adapt:1:0');
  assert.equal(app.adapted[0].query, 'first logo request');
  assert.equal(app.adapted[0].promptId, 'abc123');
  assert.match(app.calls.at(-1).payload.text, /Үлгімен дайындалды/);
});

test('another user cannot access, adapt, or save someone else’s result', async () => {
  const app = await fixture();
  await app.message('logo request');
  for (const action of ['pick', 'adapt', 'favorite']) {
    await app.callback(`${action}:1:0`, 2);
    assert.equal(app.calls.at(-1).method, 'answerCallbackQuery');
    assert.equal(app.calls.at(-1).payload.show_alert, true);
  }
  await app.callback('make:1', 2);
  assert.equal(app.calls.at(-1).payload.show_alert, true);
  assert.equal(app.adapted.length, 0);
  assert.deepEqual(app.store.listFavorites('2'), []);
});

test('long originals are sent as complete UTF-8 documents', async () => {
  const content = 'Қазақша мәтін & <tag>\n'.repeat(400);
  const app = await fixture({ service: { getPrompt: async () => ({ ...prompt, content }) } });
  await app.message('logo request');
  await app.callback('pick:1:0');
  const delivery = app.calls.at(-1);
  assert.equal(delivery.method, 'sendDocument');
  const bytes = await delivery.payload.document.toRaw();
  assert.equal(Buffer.from(bytes).toString('utf8'), content);
  assert.match(delivery.payload.document.filename, /\.txt$/);
});

test('empty search uses adaptation and saved prompts can be toggled', async () => {
  const app = await fixture();
  await app.message('logo');
  await app.callback('favorite:1:0');
  assert.deepEqual(app.store.listFavorites('1'), ['abc123']);
  await app.message('/saved');
  assert.equal(app.calls.at(-1).payload.reply_markup.inline_keyboard[0][0].callback_data, 'pick:2:0');
  await app.callback('favorite:2:0');
  assert.deepEqual(app.store.listFavorites('1'), []);

  const empty = await fixture({ service: { search: async () => ({ results: [] }) } });
  await empty.message('new task');
  assert.equal(empty.adapted[0].query, 'new task');
});

test('oversized and rate-limited requests never call search', async () => {
  let requested = 0;
  const app = await fixture({ store: { allowRequest: () => false }, service: { search: async () => { requested++; } } });
  await app.message('x'.repeat(2001));
  assert.match(app.calls.at(-1).payload.text, /2000/);
  await app.message('logo');
  assert.match(app.calls.at(-1).payload.text, /Сұраныстар/);
  assert.equal(requested, 0);
});

test('service failures return a friendly response without leaking error details', async () => {
  const app = await fixture({ service: { search: async () => { throw new Error('secret-api-token'); } } });
  await app.message('logo');
  assert.match(app.calls.at(-1).payload.text, /Сұранысты аяқтай алмадым/);
  assert.doesNotMatch(JSON.stringify(app.calls), /secret-api-token/);
});

test('HTML escaping and Mini App URLs reject unsafe values', () => {
  assert.equal(escapeHtml('<b>A&B</b>'), '&lt;b&gt;A&amp;B&lt;/b&gt;');
  for (const url of ['', 'javascript:alert(1)', 'http://localhost:3000', 'https://user:password@example.com']) {
    assert.equal(validMiniAppUrl(url), null);
  }
});

test('interaction limits cover commands, callbacks, and original downloads', async () => {
  let allowInteraction = true;
  const consumed = [];
  const app = await fixture({ store: { consume: (key) => { consumed.push(key); return allowInteraction; } } });
  await app.message('logo');
  allowInteraction = false;
  app.calls.length = 0;
  await app.message('/start');
  assert.equal(app.calls.length, 0);
  await app.callback('pick:1:0');
  assert.equal(app.calls.at(-1).method, 'answerCallbackQuery');
  assert.match(app.calls.at(-1).payload.text, /Сұраныстар/);
  assert.equal(app.calls.filter((call) => ['sendMessage', 'sendDocument'].includes(call.method)).length, 0);
  assert.equal(consumed.filter((key) => key === 'interaction:1').length, 3);
});

test('slow work preserves one user’s order while other users continue', async () => {
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const requests = [];
  const app = await fixture({ service: {
    search: async ({ query }) => {
      requests.push(query);
      if (query === 'slow') { started.resolve(); await gate.promise; }
      return { results: [{ ...prompt, description: 'Design', score: 1 }] };
    },
  } });
  const slow = app.message('slow', 1);
  await started.promise;
  const next = app.message('next', 1);
  try {
    await app.message('/start', 2);
    assert.deepEqual(requests, ['slow']);
    assert.ok(app.calls.some((call) => call.method === 'sendMessage' && call.payload.chat_id === 2));
  } finally { gate.resolve(); }
  await Promise.all([slow, next]);
  assert.deepEqual(requests, ['slow', 'next']);
});
