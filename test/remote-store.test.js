import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteStore } from '../src/remote-store.js';

function fixture(handler) {
  const requests = [];
  const store = new RemoteStore({
    url: 'https://example.supabase.co',
    apiKey: 'publishable-test-key',
    secret: 'a'.repeat(64),
    async fetchImpl(url, options) {
      const request = { url, options, body: JSON.parse(options.body) };
      requests.push(request);
      return new Response(JSON.stringify(await handler(request.body)), { status: 200 });
    },
  });
  return { store, requests };
}

test('remote user and search calls preserve explicit user ownership', async () => {
  const { store, requests } = fixture(({ op, payload }) => {
    if (op === 'get_user') return { language: 'kk', lastQuery: '' };
    if (op === 'get_search') return payload.userId === '11' ? { query: 'logo', results: [] } : null;
    return true;
  });
  assert.deepEqual(await store.getUser(11), { language: 'kk', lastQuery: '' });
  await store.setUser(11, { language: 'ru' });
  const searchId = await store.saveSearch(11, 'logo', []);
  assert.match(searchId, /^[a-f0-9]{16}$/);
  assert.deepEqual(await store.getSearch(searchId, 11), { query: 'logo', results: [] });
  assert.equal(await store.getSearch(searchId, 12), null);
  assert.equal(requests[0].url, 'https://example.supabase.co/rest/v1/rpc/prompttap_rpc');
  assert.equal(requests[0].options.headers.apikey, 'publishable-test-key');
  assert.equal(requests[0].body.secret, 'a'.repeat(64));
  assert.equal(requests[0].body.payload.id, '11');
  assert.deepEqual(requests[1].body.payload, { id: '11', patch: { language: 'ru' } });
  assert.equal(requests[2].body.payload.id, searchId);
});

test('quota and owner-bound lease operations carry consistent identifiers', async () => {
  const owner = '8cc89f45-2b7e-4bf2-bb6a-31e221694a62';
  const { store, requests } = fixture(({ op }) => op === 'claim_update' ? 'claimed' : true);
  assert.equal(await store.allowRequest(50), true);
  assert.equal(await store.claimUpdate(100, owner), 'claimed');
  assert.equal(await store.acquireUserLock(50, owner), true);
  assert.equal(await store.updateDone(100, owner), true);
  assert.equal(await store.releaseUserLock(50, owner), true);
  assert.equal(await store.releaseUpdate(100, owner), true);
  assert.deepEqual(requests[0].body.payload, { key: 'request:50', maximum: 12, windowMs: 60000 });
  assert.deepEqual(requests[1].body.payload, { id: '100', owner, ttlMs: 120000 });
  for (const request of requests.slice(1)) assert.equal(request.body.payload.owner, owner);
});

test('catalog retrieval distinguishes snippets from full prompt lookup', async () => {
  const { store, requests } = fixture(({ op }) => {
    if (op === 'catalog_page') return [{ id: 'aabbccddeeff', content: 'snippet' }];
    if (op === 'get_prompt') return { id: 'aabbccddeeff', content: 'complete original' };
    if (op === 'catalog_meta') return { total: 1, archiveTotal: 2, reviewCount: 1 };
    return 1;
  });
  assert.equal((await store.catalogPage(100, 50))[0].content, 'snippet');
  assert.equal((await store.getPrompt('aabbccddeeff')).content, 'complete original');
  assert.equal((await store.catalogMeta()).reviewCount, 1);
  assert.equal(await store.importRecords([{ id: 'aabbccddeeff' }]), 1);
  assert.deepEqual(requests[0].body.payload, { offset: 100, limit: 50 });
});

test('failed mutations are never retried and provider errors cannot disclose secrets', async () => {
  let calls = 0;
  const credential = 'test-secret-value-'.repeat(4);
  const store = new RemoteStore({
    url: 'https://example.supabase.co', apiKey: 'test-key', secret: credential,
    async fetchImpl() { calls++; throw new Error(`Request body contained ${credential}`); },
  });
  await assert.rejects(store.toggleFavorite(1, 'aabbccddeeff'), error => {
    assert.doesNotMatch(error.message, /test-secret-value/);
    return error.message === 'The data store is temporarily unavailable.';
  });
  assert.equal(calls, 1);
  store.fetch = async () => new Response(`Private SQL detail ${credential}`, { status: 500 });
  await assert.rejects(store.consume('example', 1, 1000), error => {
    assert.equal(error.statusCode, 500);
    assert.doesNotMatch(error.message, /Private SQL|test-secret-value/);
    return true;
  });
});

test('remote credentials and public network transport are validated', () => {
  assert.throws(() => new RemoteStore({ url: 'http://example.com', apiKey: 'x', secret: 'a'.repeat(64) }), /HTTPS/);
  assert.throws(() => new RemoteStore({ url: 'https://example.com', apiKey: '', secret: '' }), /incomplete/);
});

test('service-role JWTs use Authorization while opaque API keys stay in apikey', async () => {
  const requests = [];
  for (const apiKey of ['eyJhbGci.testPayload.testSignature', 'sb_secret_test']) {
    const store = new RemoteStore({
      url: 'https://example.supabase.co', apiKey, secret: 'a'.repeat(64),
      async fetchImpl(url, options) {
        requests.push(options.headers);
        return new Response('true', { status: 200 });
      },
    });
    await store.getUser('1');
  }
  assert.equal(requests[0].Authorization, 'Bearer eyJhbGci.testPayload.testSignature');
  assert.equal(requests[1].apikey, 'sb_secret_test');
  assert.equal(requests[1].Authorization, undefined);
});
