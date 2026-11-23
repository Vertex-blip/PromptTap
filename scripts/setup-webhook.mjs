import { Api } from 'grammy';

async function setup() {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, SUPABASE_URL: base, MINI_APP_URL: miniAppUrl } = process.env;
  if (!token || !secret || secret.length < 32 || !base || !miniAppUrl) throw new Error('Webhook configuration is incomplete.');
  const webhook = new URL('/functions/v1/prompttap/webhook', base);
  const app = new URL(miniAppUrl);
  if (webhook.protocol !== 'https:' || app.protocol !== 'https:') throw new Error('HTTPS is required.');
  const health = await fetch(new URL('/functions/v1/prompttap/health', base), { signal: AbortSignal.timeout(20000) });
  const website = await fetch(app, { signal: AbortSignal.timeout(20000) });
  if (!health.ok || !website.ok || !(await website.text()).includes('PromptTap')) throw new Error('Deployment is not ready.');
  const api = new Api(token);
  await api.setWebhook(webhook.href, { secret_token: secret, allowed_updates: ['message', 'callback_query'], max_connections: 20 }, AbortSignal.timeout(20000));
  await api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'PromptTap', web_app: { url: app.href } } }, AbortSignal.timeout(20000));
  const [info, menu, me] = await Promise.all([
    api.getWebhookInfo(AbortSignal.timeout(20000)),
    api.getChatMenuButton({}, AbortSignal.timeout(20000)),
    api.getMe(AbortSignal.timeout(20000)),
  ]);
  if (info.url !== webhook.href || menu.type !== 'web_app' || menu.web_app.url !== app.href) throw new Error('Webhook verification failed.');
  console.log(JSON.stringify({ username: me.username, webhook: info.url, miniApp: menu.web_app.url, pendingUpdates: info.pending_update_count, lastErrorAt: info.last_error_date || null }));
}
try { await setup(); }
catch (error) {
  console.error('Webhook setup failed', { type: error?.name || 'Error', code: error?.error_code || null });
  process.exitCode = 1;
}
