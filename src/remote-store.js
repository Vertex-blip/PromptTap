import { randomBytes } from 'node:crypto';

/** Server-only store. Never expose the application secret to a browser. */
export class RemoteStore {
  constructor({ url, apiKey, secret, fetchImpl = fetch }) {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' && endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost') {
      throw new Error('The store endpoint requires HTTPS.');
    }
    if (!apiKey || !secret || secret.length < 32) throw new Error('Store credentials are incomplete.');
    this.endpoint = new URL('/rest/v1/rpc/prompttap_rpc', endpoint).href;
    this.apiKey = apiKey;
    this.secret = secret;
    this.fetch = fetchImpl;
  }

  async call(op, payload = {}) {
    let response;
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          apikey: this.apiKey,
          'Content-Type': 'application/json',
          // Platform service-role JWTs need the role in Authorization. Modern
          // sb_secret keys authenticate through apikey and are not JWTs.
          ...(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(this.apiKey)
            ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ op, payload, secret: this.secret }),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new Error('The data store is temporarily unavailable.');
    }
    if (!response.ok) {
      // Provider bodies can include SQL details. Expose only the HTTP status.
      const error = new Error('The data store request failed.');
      error.statusCode = response.status;
      throw error;
    }
    try { return await response.json(); }
    catch { throw new Error('The data store returned an invalid response.'); }
  }

  getUser(id) { return this.call('get_user', { id: String(id) }); }
  setUser(id, patch) { return this.call('set_user', { id: String(id), patch }); }
  async saveSearch(userId, query, results) {
    const id = randomBytes(8).toString('hex');
    await this.call('save_search', { id, userId: String(userId), query, results });
    return id;
  }
  getSearch(id, userId) { return this.call('get_search', { id, userId: String(userId) }); }
  toggleFavorite(userId, promptId) { return this.call('toggle_favorite', { userId: String(userId), promptId }); }
  listFavorites(userId) { return this.call('list_favorites', { userId: String(userId) }); }
  consume(key, maximum, windowMs) { return this.call('consume', { key, maximum, windowMs }); }
  allowRequest(userId) { return this.consume(`request:${userId}`, 12, 60000); }

  claimUpdate(updateId, owner, ttlMs = 120000) {
    return this.call('claim_update', { id: String(updateId), owner, ttlMs });
  }
  updateDone(updateId, owner) { return this.call('update_done', { id: String(updateId), owner }); }
  releaseUpdate(updateId, owner) { return this.call('release_update', { id: String(updateId), owner }); }
  acquireUserLock(userId, owner, ttlMs = 120000) {
    return this.call('acquire_user_lock', { id: String(userId), owner, ttlMs });
  }
  releaseUserLock(userId, owner) { return this.call('release_user_lock', { id: String(userId), owner }); }

  catalogPage(offset = 0, limit = 100) { return this.call('catalog_page', { offset, limit }); }
  getPrompt(id) { return this.call('get_prompt', { id }); }
  catalogMeta() { return this.call('catalog_meta'); }
  importRecords(records) { return this.call('import_records', { records }); }
  close() {}
}
