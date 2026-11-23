import { timingSafeEqual, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { verifyTelegramData } from './auth.js';
import { UserError } from './service.js';

const taskSchema = z.object({
  query: z.string().trim().min(2).max(2000),
  language: z.enum(['kk', 'ru', 'en']).default('kk'),
  promptId: z.string().regex(/^[a-f0-9]{12,64}$/).optional(),
  category: z.enum(['all', 'design', 'code', 'writing', 'marketing', 'study', 'productivity', 'security', 'general']).optional(),
});

function matchesSecret(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request, maximum = 16384) {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new UserError('JSON required', 415);
  if (Number(request.headers.get('content-length')) > maximum) throw new UserError('Request too large', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new UserError('JSON required');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new UserError('Request too large', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new UserError('Invalid JSON'); }
}

export function createEdgeHandler({ loadRuntime, loadAdmin, allowedOrigin }) {
  return async request => {
    const origin = request.headers.get('origin');
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin',
    });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && origin !== allowedOrigin) return json({ error: 'Origin denied' }, 403);
    if (origin) headers.set('Access-Control-Allow-Origin', origin);
    if (request.method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
      headers.set('Access-Control-Max-Age', '600');
      return new Response(null, { status: 204, headers });
    }
    const path = new URL(request.url).pathname.replace(/^.*\/prompttap(?=\/|$)/, '') || '/';
    if (path === '/health' && request.method === 'GET') return json({ ok: true });
    if (path !== '/webhook' && path !== '/admin/catalog' && !path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    try {
      if (path === '/admin/catalog') {
        if (!loadAdmin) return json({ error: 'Not found' }, 404);
        const { config, store } = await loadAdmin();
        if (origin || !matchesSecret(request.headers.get('x-prompttap-admin-key'), config.storeSecret)) return json({ error: 'Unauthorized' }, 401);
        if (request.method === 'GET') return json(await store.catalogMeta());
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        const body = await readJson(request, 12582912);
        if (!body || !Array.isArray(body.records) || body.records.length < 1 || body.records.length > 30) throw new UserError('Import requires 1 to 30 records');
        return json({ imported: await store.importRecords(body.records) });
      }
      const base = await (loadAdmin ? loadAdmin() : loadRuntime());
      const { config, store } = base;
      if (path === '/webhook') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        if (!matchesSecret(request.headers.get('x-telegram-bot-api-secret-token'), config.webhookSecret)) return json({ error: 'Unauthorized' }, 401);
        const update = await readJson(request, 65536);
        if (!update || typeof update !== 'object' || Array.isArray(update) || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return json({ error: 'Invalid update' }, 400);
        const userId = update.message?.from?.id ?? update.callback_query?.from?.id;
        if (userId !== undefined && (!Number.isSafeInteger(userId) || userId <= 0)) return json({ error: 'Invalid sender' }, 400);
        if (userId === undefined) return json({ ok: true });
        const owner = randomUUID();
        const claim = await store.claimUpdate(update.update_id, owner, 120000);
        if (claim === 'done') return json({ ok: true });
        if (claim !== 'claimed') return json({ error: 'Retry later' }, 503);
        let locked = false;
        try {
          locked = await store.acquireUserLock(String(userId), owner, 120000);
          if (!locked) { await store.releaseUpdate(update.update_id, owner); return json({ error: 'Retry later' }, 503); }
          const { bot } = base.bot ? base : await loadRuntime();
          await bot.handleUpdate(update);
          if (!await store.updateDone(update.update_id, owner)) throw new Error('Update lease expired');
          return json({ ok: true });
        } catch (error) {
          await store.releaseUpdate(update.update_id, owner).catch(() => {});
          throw error;
        } finally {
          if (locked) await store.releaseUserLock(String(userId), owner).catch(() => {});
        }
      }
      const raw = request.headers.get('x-telegram-init-data');
      const user = verifyTelegramData(raw, config.token);
      if (raw && !user) return json({ error: 'Reopen the app in Telegram.' }, 401);
      if (path === '/api/meta' && request.method === 'GET') {
        const meta = base.getMeta ? await base.getMeta() : base.service.meta();
        return json({ ...meta, userId: user ? String(user.id) : 'visitor', requiresTelegram: !user });
      }
      if (!user) return json({ error: 'Open this app in Telegram.' }, 401);
      if (!await store.consume(`http:${user.id}`, 90, 60000)) return json({ error: 'Please wait a minute.' }, 429);
      if (['/api/search', '/api/adapt'].includes(path) && request.method === 'POST') {
        const parsed = taskSchema.safeParse(await readJson(request));
        if (!parsed.success) throw new UserError('Use a task of 2–2000 characters.');
        if (!await store.allowRequest(String(user.id))) throw new UserError('Please wait a minute.', 429);
        const { service } = base.service ? base : await loadRuntime();
        return json(await (path.endsWith('/search') ? service.search(parsed.data) : service.adapt(parsed.data)));
      }
      const match = /^\/api\/prompts\/([a-f0-9]{12,64})(\/download)?$/.exec(path);
      if (match && request.method === 'GET') {
        const prompt = await (base.service ? base.service.getPrompt(match[1]) : store.getPrompt(match[1]));
        if (!prompt) throw new UserError('Prompt unavailable', 404);
        if (!match[2]) return json(prompt);
        headers.set('Content-Type', 'text/plain; charset=utf-8');
        headers.set('Content-Disposition', `attachment; filename="PromptTap-${prompt.id}.txt"`);
        return new Response(prompt.content, { headers });
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      if (error instanceof UserError) return json({ error: error.message }, error.status);
      console.error('PromptTap edge request failed', { type: error?.name });
      return json({ error: 'Please try again shortly.' }, 503);
    }
  };
}
