import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server.js';
import { verifyTelegramData } from '../src/auth.js';
import { Store } from '../src/store.js';
import { createService } from '../src/service.js';

const token = '123456:test-token';
const record = {
  id: 'abcdef123456', title: 'Logo design', content: 'Create a logo with a <brand> & color palette.',
  sources: ['archive.zip/logo.txt'], category: 'design', language: 'en', reviewRequired: false,
};

function signedData(userId = 71, date = Math.floor(Date.now() / 1000), extra = {}) {
  const params = new URLSearchParams({
    auth_date: String(date), user: JSON.stringify({ id: userId, first_name: 'Test' }),
    query_id: 'local-test', ...extra,
  });
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const payload = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  params.set('hash', createHmac('sha256', secret).update(payload).digest('hex'));
  return params.toString();
}

async function fixture(t, overrides = {}) {
  const store = new Store();
  const config = { token: '', production: false, ...overrides.config };
  const service = createService({
    catalog: [record, { ...record, id: 'abcdef999999', title: 'Review required', reviewRequired: true }],
    config, ai: { enabled: false },
  });
  const app = createApp({ config, service, store });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    store.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', body, rawBody, initData, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(initData ? { 'X-Telegram-Init-Data': initData } : {}), ...headers },
      ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
  }
  return { store, service, request };
}

test('Telegram signatures accept valid data and reject tampered, stale, future, or duplicate data', () => {
  const now = 1806000000000;
  const date = Math.floor(now / 1000);
  const valid = signedData(71, date);
  assert.equal(verifyTelegramData(valid, token, now).id, 71);
  assert.equal(verifyTelegramData(valid.replace('Test', 'Other'), token, now), null);
  assert.equal(verifyTelegramData(valid, 'wrong-token', now), null);
  assert.equal(verifyTelegramData(signedData(71, date - 3601), token, now), null);
  assert.equal(verifyTelegramData(signedData(71, date + 31), token, now), null);
  assert.equal(verifyTelegramData(`${valid}&auth_date=${date}`, token, now), null);
  assert.equal(verifyTelegramData(signedData(-1, date), token, now), null);
  assert.equal(verifyTelegramData(signedData('71', date), token, now), null);
  assert.equal(verifyTelegramData(signedData(71, date, { user: 'invalid-json' }), token, now), null);
});

test('production rejects unsigned and malformed Telegram requests but accepts valid signatures', async (t) => {
  const app = await fixture(t, { config: { production: true, token } });
  assert.equal((await app.request('/health')).status, 200);
  assert.equal((await app.request('/api/meta')).status, 401);
  assert.equal((await app.request('/api/meta', { initData: 'invalid' })).status, 401);
  const result = await app.request('/api/meta', { initData: signedData() });
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 1);
  assert.equal(result.body.reviewCount, 1);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('search, fallback adaptation, originals, and downloads work through HTTP', async (t) => {
  const app = await fixture(t);
  const search = await app.request('/api/search', { method: 'POST', body: { query: 'logo design', language: 'en' } });
  assert.equal(search.status, 200);
  assert.equal(search.body.results[0].id, record.id);
  const unknown = await app.request('/api/search', { method: 'POST', body: { query: 'zyzzyva honeybee taxonomy', language: 'en' } });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body.results, []);
  assert.equal(unknown.body.adaptation.mode, 'template');
  assert.match(unknown.body.adaptation.text, /zyzzyva honeybee taxonomy/);
  const detail = await app.request(`/api/prompts/${record.id}`);
  assert.equal(detail.body.content, record.content);
  const download = await app.request(`/api/prompts/${record.id}/download`);
  assert.equal(download.text, record.content);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.match(download.headers.get('content-type'), /text\/plain/);
});

test('invalid requests, hidden records, missing records, and path injection remain bounded', async (t) => {
  const app = await fixture(t);
  for (const body of [{}, { query: 'x' }, { query: 'x'.repeat(2001) }, { query: 'logo', language: 'xx' }, { query: 'logo', promptId: '../secret' }]) {
    assert.equal((await app.request('/api/adapt', { method: 'POST', body })).status, 400);
  }
  assert.equal((await app.request('/api/search', { method: 'POST', rawBody: '{' })).status, 400);
  const oversized = await app.request('/api/search', { method: 'POST', body: { query: 'x'.repeat(20000) } });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.get('cache-control'), 'no-store');
  for (const id of ['abcdef999999', 'aaaaaaaaaaaa', '%3Cscript%3E', '..%2F.env']) {
    const response = await app.request(`/api/prompts/${id}`);
    assert.equal(response.status, 404);
    assert.doesNotMatch(response.text, /TELEGRAM_BOT_TOKEN|<script>/);
  }
  assert.equal((await app.request('/api/missing')).status, 404);
});

test('signed users have separate rate limits', async (t) => {
  const app = await fixture(t, { config: { production: true, token } });
  for (let index = 0; index < 12; index++) {
    const response = await app.request('/api/search', { method: 'POST', body: { query: 'logo design' }, initData: signedData(1) });
    assert.equal(response.status, 200);
  }
  assert.equal((await app.request('/api/search', { method: 'POST', body: { query: 'logo design' }, initData: signedData(1) })).status, 429);
  assert.equal((await app.request('/api/search', { method: 'POST', body: { query: 'logo design' }, initData: signedData(2) })).status, 200);
});

test('persistent store scopes searches and favorites to their owners', () => {
  const store = new Store();
  try {
    const id = store.saveSearch('1', "O'Reilly logo", [{ id: record.id }]);
    assert.equal(store.getSearch(id, '1').query, "O'Reilly logo");
    assert.equal(store.getSearch(id, '2'), null);
    assert.equal(store.getSearch("' OR 1=1 --", '2'), null);
    store.setUser('1', { language: 'ru' });
    assert.equal(store.getUser('1').language, 'ru');
    assert.equal(store.getUser('2').language, 'kk');
    assert.equal(store.toggleFavorite('1', record.id), true);
    assert.deepEqual(store.listFavorites('1'), [record.id]);
    assert.deepEqual(store.listFavorites('2'), []);
    assert.equal(store.toggleFavorite('1', record.id), false);
    assert.deepEqual(store.listFavorites('1'), []);
    assert.equal(store.consume('budget', 1, 60000), true);
    assert.equal(store.consume('budget', 1, 60000), false);
    store.db.prepare('UPDATE limits SET expires=0 WHERE key=?').run('budget');
    assert.equal(store.consume('budget', 1, 60000), true);
  } finally { store.close(); }
});
