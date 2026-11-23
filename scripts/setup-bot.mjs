import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Api, InputFile } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';

try {
  loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const descriptions = {
  '': {
    full: 'Тапсырмаңды жаз — PromptTap архивтен сәйкес промптты табады. Түпнұсқаны аш, сақта немесе сұранысыңа бейімде. Қазақша, орысша және ағылшынша іздеу. Дәл нұсқа табылмаса, тапсырмаға арналған үлгі дайындайды.',
    short: 'Қажет промптты тап, сақта және тапсырмаңа бейімде. Қазақша · Русский · English',
  },
  ru: {
    full: 'Опиши задачу — PromptTap найдёт подходящий промпт в архиве. Открой оригинал, сохрани или адаптируй под свой запрос. Поиск на русском, казахском и английском. Если точного варианта нет, бот подготовит шаблон под задачу.',
    short: 'Находи, сохраняй и адаптируй промпты под свои задачи. Қазақша · Русский · English',
  },
  en: {
    full: 'Describe your task and PromptTap will find matching prompts in the archive. Open the original, save it, or adapt it to your request. Search in English, Kazakh, and Russian. If there is no close match, the bot prepares a template for your task.',
    short: 'Find, save, and adapt prompts for your tasks. Қазақша · Русский · English',
  },
};

async function setup() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
  const api = new Api(token);
  api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 20 }));
  const me = await api.getMe(AbortSignal.timeout(20000));
  for (const [language_code, description] of Object.entries(descriptions)) {
    await api.setMyName('PromptTap', { language_code }, AbortSignal.timeout(20000));
    await api.setMyDescription(description.full, { language_code }, AbortSignal.timeout(20000));
    await api.setMyShortDescription(description.short, { language_code }, AbortSignal.timeout(20000));
  }
  const avatarPath = fileURLToPath(new URL('../public/brand-avatar.jpg', import.meta.url));
  await api.setMyProfilePhoto({ type: 'static', photo: new InputFile(avatarPath) }, AbortSignal.timeout(30000));

  const [name, defaultDescription, russianDescription, englishDescription, profilePhotos] = await Promise.all([
    api.getMyName({}, AbortSignal.timeout(20000)),
    api.getMyDescription({}, AbortSignal.timeout(20000)),
    api.getMyDescription({ language_code: 'ru' }, AbortSignal.timeout(20000)),
    api.getMyDescription({ language_code: 'en' }, AbortSignal.timeout(20000)),
    api.getUserProfilePhotos(me.id, { limit: 1 }, AbortSignal.timeout(20000)),
  ]);
  if (name.name !== 'PromptTap'
    || defaultDescription.description !== descriptions[''].full
    || russianDescription.description !== descriptions.ru.full
    || englishDescription.description !== descriptions.en.full
    || profilePhotos.total_count < 1) {
    throw new Error('BRANDING_VERIFICATION_FAILED');
  }
  console.log(JSON.stringify({ username: me.username, brandingVerified: true, profilePhotoCount: profilePhotos.total_count }));
}

try {
  await setup();
} catch (error) {
  // API error objects may contain authenticated URLs. Only emit bounded metadata.
  console.error('Bot branding setup failed', { type: error?.name || 'Error', code: error?.error_code || null });
  process.exitCode = 1;
}
