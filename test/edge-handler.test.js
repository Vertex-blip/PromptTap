import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createEdgeHandler } from '../src/edge-handler.js';

const token = '123456:edge-test-only';
const webhookSecret = 'test-webhook-secret';
const storeSecret = 'test-admin-secret';
const allowedOrigin = 'https://vertex-blip.github.io';
const record = {
  id: 'abcdef123456', title: 'Logo design', content: 'Қазақша <logo> & color palette.',
  sources: ['archive.zip/logo.txt'], language: 'en', category: 'design',
};

function signedData(id = 71, date = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    auth_date: String(date), user: JSON.stringify({ id, first_name: 'Test' }), query_id: 'test',
  });
  const payload = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(payload).digest('hex'));
  return params.toString();
}

function fixture(overrides = {}) {
  const calls = [];
  let runtimeLoads = 0;
  const store = {};
  const methods = {
    consume: async () => true,
    allowRequest: async () => true,
    claimUpdate: async () => 'claimed',
    acquireUserLock: async () => true,
    releaseUpdate: async () => true,
    updateDone: async () => true,
    releaseUserLock: async () => true,
    catalogMeta: async () => ({ count: 1 }),
    importRecords: async records => records.length,
    ...overrides.store,
  };
  for (const [name, method] of Object.entries(methods)) {
    store[name] = async (...args) => { calls.push({ name, args }); return method(...args); };
  }
  const service = {
    meta: () => ({ total: 1, archiveTotal: 2, reviewCount: 1, aiConfigured: true }),
    search: async (input) => { calls.push({ name: 'search', args: [input] }); return { results: [record] }; },
    adapt: async (input) => { calls.push({ name: 'adapt', args: [input] }); return { text: 'Adapted prompt', mode: 'ai' }; },
    getPrompt: async (id) => id === record.id ? record : null,
    ...overrides.service,
  };
  const handler = createEdgeHandler({
    allowedOrigin,
    ...(overrides.admin ? { loadAdmin: async () => ({ config: { storeSecret }, store }) } : {}),
    loadRuntime: async () => {
      runtimeLoads++;
      return {
        config: { token, webhookSecret }, store, service,
        bot: { handleUpdate: async (update) => {
          calls.push({ name: 'handleUpdate', args: [update] });
          if (overrides.handleUpdate) await overrides.handleUpdate(update);
        } },
      };
    },
  });
  async function request(path, { method = 'GET', body, rawBody, initData, origin, headers = {} } = {}) {
    const requestHeaders = new Headers(headers);
    if (body !== undefined || rawBody !== undefined) requestHeaders.set('Content-Type', 'application/json');
    if (initData !== undefined) requestHeaders.set('X-Telegram-Init-Data', initData);
    if (origin !== undefined) requestHeaders.set('Origin', origin);
    const response = await handler(new Request(`https://example.supabase.co/functions/v1/prompttap${path}`, {
      method, headers: requestHeaders,
      ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    }));
    const text = await response.text();
    return {
      status: response.status, headers: response.headers, text,
      body: text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null,
    };
  }
  const webhook = (update, headers = {}) => request('/webhook', {
    method: 'POST', body: update,
    headers: { 'X-Telegram-Bot-Api-Secret-Token': webhookSecret, ...headers },
  });
  return { request, webhook, calls, loads: () => runtimeLoads };
}

const update = { update_id: 121, message: { message_id: 1, from: { id: 71, is_bot: false }, text: 'logo' } };

test('edge API exposes unsigned metadata and requires valid Telegram signatures for prompt operations', async () => {
  const app = fixture();
  const metadata = await app.request('/api/meta');
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.userId, 'visitor');
  assert.equal(metadata.body.requiresTelegram, true);
  assert.equal((await app.request(`/api/prompts/${record.id}`)).status, 401);
  const signed = await app.request('/api/meta', { initData: signedData() });
  assert.equal(signed.body.userId, '71');
  assert.equal(signed.body.requiresTelegram, false);
  for (const invalid of [signedData().replace('Test', 'Other'), signedData(71, Math.floor(Date.now() / 1000) - 3700), 'malformed']) {
    assert.equal((await app.request('/api/meta', { initData: invalid })).status, 401);
    assert.equal((await app.request('/api/search', { method: 'POST', body: { query: 'logo' }, initData: invalid })).status, 401);
  }
  assert.equal(app.calls.length, 0);
});

test('edge CORS allows only the exact Pages origin and preflight avoids loading runtime', async () => {
  const app = fixture();
  const preflight = await app.request('/api/search', { method: 'OPTIONS', origin: allowedOrigin });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-Telegram-Init-Data/);
  assert.equal(preflight.headers.get('vary'), 'Origin');
  assert.equal(app.loads(), 0);
  for (const origin of ['https://vertex-blip.github.io.evil.example', 'https://other.github.io', 'null']) {
    const denied = await app.request('/api/meta', { origin });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(app.loads(), 0);
  const health = await app.request('/health');
  assert.equal(health.status, 200);
  assert.equal(app.loads(), 0);
});

test('authenticated API routes preserve downloads and await both rate budgets', async () => {
  const app = fixture();
  const request = { method: 'POST', body: { query: 'logo design', language: 'en' }, initData: signedData() };
  assert.equal((await app.request('/api/search', request)).body.results[0].id, record.id);
  assert.equal((await app.request('/api/adapt', request)).body.mode, 'ai');
  const download = await app.request(`/api/prompts/${record.id}/download`, { initData: signedData() });
  assert.equal(download.text, record.content);
  assert.match(download.headers.get('content-disposition'), /PromptTap-abcdef123456\.txt/);
  assert.match(download.headers.get('content-type'), /text\/plain/);
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.equal((await app.request('/api/prompts/000000000000', { initData: signedData() })).status, 404);
  assert.deepEqual(app.calls.find(call => call.name === 'consume').args, ['http:71', 90, 60000]);
  assert.deepEqual(app.calls.find(call => call.name === 'allowRequest').args, ['71']);

  for (const limitedMethod of ['consume', 'allowRequest']) {
    const limited = fixture({ store: { [limitedMethod]: async () => false } });
    assert.equal((await limited.request('/api/search', request)).status, 429);
    assert.equal(limited.calls.some(call => call.name === 'search'), false);
  }
});

test('API rejects malformed and oversized JSON before service work including inaccurate content length', async () => {
  const app = fixture();
  const base = { method: 'POST', initData: signedData() };
  assert.equal((await app.request('/api/search', { ...base, rawBody: '{oops' })).status, 400);
  assert.equal((await app.request('/api/search', { ...base, body: { query: 'x'.repeat(2001) } })).status, 400);
  assert.equal((await app.request('/api/search', { ...base, body: null })).status, 400);
  assert.equal((await app.request('/api/search', { ...base, rawBody: 'x'.repeat(17000), headers: { 'Content-Length': '4' } })).status, 413);
  assert.equal((await app.request('/api/search', { ...base, rawBody: '{}', headers: { 'Content-Length': '17000' } })).status, 413);
  assert.equal((await app.request('/api/search', base)).status, 415);
  assert.equal(app.calls.some(call => call.name === 'search'), false);
});

test('webhook authentication and validated update shape precede lease claims', async () => {
  const app = fixture();
  assert.equal((await app.request('/webhook', { method: 'POST', body: update })).status, 401);
  assert.equal((await app.webhook(update, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' })).status, 401);
  assert.equal((await app.request('/webhook')).status, 405);
  for (const invalid of [null, [], {}, { ...update, update_id: -1 }, { ...update, update_id: '121' }]) {
    assert.equal((await app.webhook(invalid)).status, 400);
  }
  assert.equal((await app.webhook({ update_id: 121, message: { from: { id: -71 } } })).status, 400);
  assert.equal((await app.webhook({ update_id: 121, edited_message: { from: { id: 71 } } })).status, 200);
  assert.equal(app.calls.length, 0);
});

test('webhook leases use one owner and completed or busy updates never execute twice', async () => {
  const app = fixture();
  assert.equal((await app.webhook(update)).status, 200);
  assert.deepEqual(app.calls.map(call => call.name), ['claimUpdate', 'acquireUserLock', 'handleUpdate', 'updateDone', 'releaseUserLock']);
  const owner = app.calls[0].args[1];
  assert.match(owner, /^[a-f0-9-]{36}$/);
  assert.deepEqual(app.calls[0].args, [121, owner, 120000]);
  assert.deepEqual(app.calls[1].args, ['71', owner, 120000]);
  assert.deepEqual(app.calls[3].args, [121, owner]);
  assert.deepEqual(app.calls[4].args, ['71', owner]);
  for (const [claim, status] of [['done', 200], ['busy', 503]]) {
    const duplicate = fixture({ store: { claimUpdate: async () => claim } });
    assert.equal((await duplicate.webhook(update)).status, status);
    assert.deepEqual(duplicate.calls.map(call => call.name), ['claimUpdate']);
  }
});

test('busy user releases the update lease without releasing an unowned user lock', async () => {
  const app = fixture({ store: { acquireUserLock: async () => false } });
  assert.equal((await app.webhook(update)).status, 503);
  assert.deepEqual(app.calls.map(call => call.name), ['claimUpdate', 'acquireUserLock', 'releaseUpdate']);
  assert.equal(app.calls[0].args[1], app.calls[2].args[1]);
});

test('webhook failures release owned leases and redact dependency errors', async () => {
  for (const failure of ['bot', 'completion', 'ownership']) {
    const app = fixture({
      ...(failure === 'bot' ? { handleUpdate: async () => { throw new Error('private-key-material'); } } : {}),
      store: failure === 'completion' ? { updateDone: async () => { throw new Error('private-key-material'); } }
        : failure === 'ownership' ? { updateDone: async () => false } : {},
    });
    const response = await app.webhook(update);
    assert.equal(response.status, 503);
    assert.doesNotMatch(response.text, /private-key-material/);
    assert.deepEqual(app.calls.slice(-2).map(call => call.name), ['releaseUpdate', 'releaseUserLock']);
    const owner = app.calls[0].args[1];
    assert.equal(app.calls.at(-2).args[1], owner);
    assert.equal(app.calls.at(-1).args[1], owner);
  }
  const cleanupFailure = fixture({ store: { releaseUserLock: async () => { throw new Error('temporary outage'); } } });
  assert.equal((await cleanupFailure.webhook(update)).status, 200);
  assert.equal(cleanupFailure.calls.at(-1).name, 'releaseUserLock');
});

test('failed lock acquisition releases only the update claim and cleanup errors remain private', async () => {
  const app = fixture({ store: {
    acquireUserLock: async () => { throw new Error('private connection error'); },
    releaseUpdate: async () => { throw new Error('private release error'); },
  } });
  const response = await app.webhook(update);
  assert.equal(response.status, 503);
  assert.doesNotMatch(response.text, /private/);
  assert.deepEqual(app.calls.map(call => call.name), ['claimUpdate', 'acquireUserLock', 'releaseUpdate']);
  assert.equal(app.calls[0].args[1], app.calls.at(-1).args[1]);

  const failedRelease = fixture({
    handleUpdate: async () => { throw new Error('private bot error'); },
    store: { releaseUpdate: async () => { throw new Error('private release error'); } },
  });
  assert.equal((await failedRelease.webhook(update)).status, 503);
  assert.equal(failedRelease.calls.at(-1).name, 'releaseUserLock');
});

test('catalog import requires a server admin secret and validates its batch before writing', async () => {
  assert.equal((await fixture().request('/admin/catalog')).status, 404);
  const app = fixture({ admin: true });
  const admin = { headers: { 'X-PromptTap-Admin-Key': storeSecret } };
  for (const options of [{}, { initData: signedData() }, { headers: { 'X-PromptTap-Admin-Key': 'wrong' } }, { ...admin, origin: allowedOrigin }]) {
    assert.equal((await app.request('/admin/catalog', options)).status, 401);
  }
  assert.equal(app.calls.length, 0);
  assert.equal((await app.request('/admin/catalog', admin)).body.count, 1);
  for (const body of [null, {}, { records: [] }, { records: Array(31).fill(record) }]) {
    assert.equal((await app.request('/admin/catalog', { ...admin, method: 'POST', body })).status, 400);
  }
  assert.equal(app.calls.some(call => call.name === 'importRecords'), false);
  const imported = await app.request('/admin/catalog', { ...admin, method: 'POST', body: { records: [record] } });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.imported, 1);
  assert.deepEqual(app.calls.at(-1), { name: 'importRecords', args: [[record]] });
  assert.equal(app.loads(), 0);
});
