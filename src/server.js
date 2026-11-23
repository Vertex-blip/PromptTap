import express from 'express';
import helmet from 'helmet';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { verifyTelegramData } from './auth.js';
import { UserError } from './service.js';

const requestSchema = z.object({
  query: z.string().trim().min(2).max(2000),
  language: z.enum(['kk', 'ru', 'en']).default('kk'),
  category: z.enum(['all', 'design', 'code', 'writing', 'marketing', 'study', 'productivity', 'security', 'general']).optional(),
  promptId: z.string().regex(/^[a-f0-9]{12,64}$/).optional(),
});

export function createApp({ config, service, store }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      'script-src': ["'self'", 'https://telegram.org'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'self'", 'https://web.telegram.org', 'https://*.telegram.org'],
      'upgrade-insecure-requests': config.production ? [] : null,
    } },
    frameguard: false,
    strictTransportSecurity: config.production ? undefined : false,
  }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', (req, res, next) => {
    const raw = req.get('X-Telegram-Init-Data');
    const user = verifyTelegramData(raw, config.token);
    if ((config.production || raw) && !user) return res.status(401).json({ error: 'Telegram арқылы қайта ашыңыз. / Reopen this app in Telegram.' });
    req.userId = user ? String(user.id) : `preview:${ipKeyGenerator(req.ip)}`;
    req.signedUser = user;
    next();
  });
  app.use('/api', rateLimit({ windowMs: 60000, limit: 90, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: req => req.userId,
    message: { error: 'Сәл күтіп, қайта көріңіз. / Too many requests. Please wait.' },
  }));
  app.use('/api', express.json({ limit: '16kb' }));
  app.get('/api/meta', (req, res) => res.json({ ...service.meta(), userId: req.signedUser ? req.userId : 'preview' }));
  app.post(['/api/search', '/api/adapt'], async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) throw new UserError('Сұранысты тексеріңіз. / Enter a task of 2–2000 characters.');
    if (!await store.allowRequest(req.userId)) throw new UserError('Бір минуттан кейін қайталап көріңіз. / Try again in one minute.', 429);
    const result = req.path === '/api/search' ? await service.search(parsed.data) : await service.adapt(parsed.data);
    res.json(result);
  });
  app.get(['/api/prompts/:id', '/api/prompts/:id/download'], async (req, res) => {
    const prompt = await service.getPrompt(req.params.id);
    if (!prompt) throw new UserError('Промпт табылмады. / Prompt unavailable.', 404);
    if (req.path.endsWith('/download')) {
      res.set('Content-Disposition', `attachment; filename="PromptTap-${prompt.id}.txt"`);
      return res.type('text/plain').send(prompt.content);
    }
    res.json(prompt);
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { maxAge: config.production ? '1h' : 0 }));
  app.use((error, _req, res, _next) => {
    if (error instanceof UserError) return res.status(error.status).json({ error: error.message });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Сұраныс тым ұзын. / Request too large.' });
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Invalid JSON' });
    console.error('Request failed', { type: error.name });
    res.status(500).json({ error: 'Қайта көріңіз. / Something went wrong. Please try again.' });
  });
  return app;
}
