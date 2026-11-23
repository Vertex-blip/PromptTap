import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { Buffer } from 'node:buffer';
import { autoRetry } from '@grammyjs/auto-retry';
import { sequentialize } from '@grammyjs/runner';

const messages = {
  kk: {
    welcome: '<b>PromptTap</b>\n\nҚандай тапсырмаға промпт керек? Сұрағыңды жаз — архивтен сәйкес нұсқаларды табамын. Дәл келетіні болмаса, сұранысыңа бейімдеп дайындаймын.',
    example: 'Мысалы, «Киім дүкеніне логотип жасауға промпт керек».',
    help: '<b>PromptTap қалай жұмыс істейді</b>\n\nТапсырмаңды, мақсатыңды және қажет нәтижені жаз. Сәйкес промптты ашып, көшіріп алуға, файл ретінде жүктеуге немесе бейімдеуге болады.\n\n/search — жаңа іздеу\n/saved — сақталғандар\n/language — тіл таңдау\n/help — көмек',
    ask: 'Қандай тапсырмаға промпт іздейміз? Мақсатың мен қажет нәтижеңді жаз.',
    language: 'Интерфейс тілін таңда.',
    languageSet: 'Қазақ тілі таңдалды.',
    saved: 'Сақталғандар',
    openApp: 'PromptTap ашу',
    results: 'Сұранысыңа сәйкес промпттар',
    original: 'Түпнұсқа',
    adapt: 'Бейімдеу',
    make: 'Осы сұранысқа дайындау',
    favorite: 'Сақтау / алып тастау',
    stored: 'Сақталды',
    removed: 'Сақталғандардан алынды',
    source: 'Дереккөз',
    moreSources: 'тағы дереккөз',
    emptySaved: 'Әзірге сақталған промпт жоқ. Іздеуден тапқан промпттағы «Сақтау» батырмасын бас.',
    missing: 'Бұл промпт қазір қолжетімсіз. Қайта іздеп көр.',
    expired: 'Бұл іздеу ескірген немесе басқа пайдаланушыға тиесілі. Сұранысыңды қайта жібер.',
    tooLong: 'Сұранысты 2000 таңбаға дейін қысқарт.',
    limited: 'Сұраныстар жиілеп кетті. Сәл күтіп, қайта көр.',
    error: 'Сұранысты аяқтай алмадым. Біраздан соң қайта көр.',
    ai: 'Сұранысыңа бейімделді',
    template: 'Үлгімен дайындалды',
    templateNote: 'ИИ бейімдеуі қазір қолжетімсіз. Бұл нұсқа тапсырмаңа арналған үлгімен құрастырылды.',
    previous: '← Алдыңғы',
    next: 'Келесі →',
    noText: 'Промпт іздеу үшін тапсырмаңды мәтінмен жібер.',
  },
  ru: {
    welcome: '<b>PromptTap</b>\n\nДля какой задачи нужен промпт? Напиши запрос — я найду подходящие варианты в архиве. Если точного совпадения нет, подготовлю вариант под твою задачу.',
    example: 'Например, «Нужен промпт для логотипа магазина одежды».',
    help: '<b>Как пользоваться PromptTap</b>\n\nОпиши задачу, цель и ожидаемый результат. Промпт можно открыть, скопировать, скачать файлом или адаптировать.\n\n/search — новый поиск\n/saved — сохранённое\n/language — выбрать язык\n/help — помощь',
    ask: 'Для какой задачи ищем промпт? Опиши цель и ожидаемый результат.',
    language: 'Выбери язык интерфейса.',
    languageSet: 'Выбран русский язык.',
    saved: 'Сохранённое',
    openApp: 'Открыть PromptTap',
    results: 'Промпты по твоему запросу',
    original: 'Оригинал',
    adapt: 'Адаптировать',
    make: 'Подготовить под этот запрос',
    favorite: 'Сохранить / убрать',
    stored: 'Сохранено',
    removed: 'Убрано из сохранённого',
    source: 'Источник',
    moreSources: 'других источников',
    emptySaved: 'Здесь пока пусто. Найди промпт и нажми кнопку «Сохранить».',
    missing: 'Этот промпт сейчас недоступен. Попробуй поискать снова.',
    expired: 'Этот поиск устарел или принадлежит другому пользователю. Отправь запрос заново.',
    tooLong: 'Сократи запрос до 2000 символов.',
    limited: 'Слишком много запросов. Немного подожди и повтори.',
    error: 'Не удалось завершить запрос. Попробуй немного позже.',
    ai: 'Адаптировано под твой запрос',
    template: 'Подготовлено по шаблону',
    templateNote: 'ИИ-адаптация сейчас недоступна. Этот вариант собран из шаблона под твою задачу.',
    previous: '← Назад',
    next: 'Далее →',
    noText: 'Отправь задачу текстом, чтобы найти промпт.',
  },
  en: {
    welcome: '<b>PromptTap</b>\n\nWhat do you need a prompt for? Describe your task and I’ll find matching prompts in the archive. If there is no close match, I’ll prepare a version for your request.',
    example: 'For example, “I need a prompt for a clothing store logo.”',
    help: '<b>Using PromptTap</b>\n\nDescribe your task, goal, and expected output. Open a prompt to copy it, download it, or adapt it.\n\n/search — new search\n/saved — saved prompts\n/language — choose language\n/help — help',
    ask: 'What do you need a prompt for? Describe your goal and expected output.',
    language: 'Choose your interface language.',
    languageSet: 'English selected.',
    saved: 'Saved prompts',
    openApp: 'Open PromptTap',
    results: 'Prompts matching your request',
    original: 'Original',
    adapt: 'Adapt',
    make: 'Prepare for this request',
    favorite: 'Save / remove',
    stored: 'Saved',
    removed: 'Removed from saved prompts',
    source: 'Source',
    moreSources: 'more sources',
    emptySaved: 'No saved prompts yet. Find a prompt and use its Save button.',
    missing: 'This prompt is currently unavailable. Try another search.',
    expired: 'This search expired or belongs to another user. Send your request again.',
    tooLong: 'Please shorten your request to 2000 characters.',
    limited: 'Too many requests. Wait a moment and try again.',
    error: 'The request could not be completed. Please try again shortly.',
    ai: 'Adapted for your request',
    template: 'Prepared from a template',
    templateNote: 'AI adaptation is currently unavailable. This version uses a template for your task.',
    previous: '← Previous',
    next: 'Next →',
    noText: 'Describe your task in a text message to find a prompt.',
  },
};

export function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function validMiniAppUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function filename(title) {
  return `${String(title).replace(/[^\p{L}\p{N}_ -]/gu, '').trim().slice(0, 70) || 'prompt'}.txt`;
}

function compact(value, length) {
  const text = String(value || '').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function createBot({ token, miniAppUrl, service, store }) {
  const bot = new Bot(token);
  const appUrl = validMiniAppUrl(miniAppUrl);
  const requestUsers = new WeakMap();
  bot.api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 20 }));

  const userId = (ctx) => String(ctx.from.id);
  const language = (ctx) => {
    const selected = requestUsers.get(ctx)?.language;
    return Object.hasOwn(messages, selected) ? selected : 'kk';
  };
  const words = (ctx) => messages[language(ctx)];

  function homeKeyboard(ctx) {
    const text = words(ctx);
    const keyboard = new InlineKeyboard();
    if (appUrl && ctx.chat?.type === 'private') keyboard.webApp(text.openApp, appUrl).row();
    return keyboard.text(text.saved, 'saved:0').text('ҚАЗ · РУС · ENG', 'language');
  }

  function promptKeyboard(text, searchId, index, canAdapt) {
    const keyboard = new InlineKeyboard();
    if (canAdapt) keyboard.text(text.adapt, `adapt:${searchId}:${index}`).row();
    return keyboard.text(text.favorite, `favorite:${searchId}:${index}`);
  }

  async function sendPrompt(ctx, prompt, searchId, index, canAdapt) {
    const text = words(ctx);
    const sourceLines = (prompt.sources || []).slice(0, 2).map((source) => escapeHtml(compact(source, 210)));
    if (prompt.sources?.length > 2) sourceLines.push(`+${prompt.sources.length - 2} ${text.moreSources}`);
    const heading = `<b>${escapeHtml(compact(prompt.title, 160))}</b>\n${text.original}`;
    const sources = sourceLines.length ? `\n\n${text.source}\n${sourceLines.join('\n')}` : '';
    const reply_markup = promptKeyboard(text, searchId, index, canAdapt);
    if (prompt.content.length <= 2600) {
      await ctx.reply(`${heading}\n\n<pre>${escapeHtml(prompt.content)}</pre>${sources}`, {
        parse_mode: 'HTML', reply_markup,
      });
    } else {
      await ctx.replyWithDocument(new InputFile(Buffer.from(prompt.content, 'utf8'), filename(prompt.title)), {
        caption: `${heading}${sources}`, parse_mode: 'HTML', reply_markup,
      });
    }
  }

  async function sendAdaptation(ctx, adaptation) {
    const text = words(ctx);
    const heading = adaptation.mode === 'ai' ? text.ai : text.template;
    const note = adaptation.mode === 'ai' ? '' : `\n\n${text.templateNote}`;
    if (adaptation.text.length <= 3000) {
      await ctx.reply(`<b>${heading}</b>\n\n<pre>${escapeHtml(adaptation.text)}</pre>${note}`, {
        parse_mode: 'HTML',
      });
    } else {
      await ctx.replyWithDocument(new InputFile(Buffer.from(adaptation.text, 'utf8'), 'PromptTap.txt'), {
        caption: `${heading}${note}`,
      });
    }
  }

  async function search(ctx, rawQuery) {
    const text = words(ctx);
    const query = rawQuery.trim();
    if (!query) return ctx.reply(text.ask);
    if (query.length > 2000) return ctx.reply(text.tooLong);
    if (!await store.allowRequest(userId(ctx))) return ctx.reply(text.limited);
    await store.setUser(userId(ctx), { lastQuery: query });
    await ctx.replyWithChatAction('typing');
    const response = await service.search({ query, language: language(ctx) });
    const results = response.results.slice(0, 3);
    const searchId = await store.saveSearch(userId(ctx), query, results);
    if (results.length) {
      const body = results.map((result, index) => `${index + 1}. <b>${escapeHtml(compact(result.title, 150))}</b>\n${escapeHtml(compact(result.description, 240))}`).join('\n\n');
      const keyboard = new InlineKeyboard();
      results.forEach((result, index) => keyboard.text(`${index + 1}. ${compact(result.title, 38)}`, `pick:${searchId}:${index}`).row());
      keyboard.text(text.make, `make:${searchId}`);
      await ctx.reply(`<b>${text.results}</b>\n\n${body}`, { parse_mode: 'HTML', reply_markup: keyboard });
    }
    if (response.adaptation) await sendAdaptation(ctx, response.adaptation);
    if (!results.length && !response.adaptation) {
      const adaptation = await service.adapt({ query, language: language(ctx) });
      await sendAdaptation(ctx, adaptation);
    }
  }

  async function saved(ctx, offset = 0) {
    const text = words(ctx);
    const ids = await store.listFavorites(userId(ctx));
    const prompts = (await Promise.all(ids.map((id) => service.getPrompt(id)))).filter(Boolean);
    if (!prompts.length) return ctx.reply(text.emptySaved);
    const start = Math.min(offset, Math.floor((prompts.length - 1) / 8) * 8);
    const page = prompts.slice(start, start + 8);
    const searchId = await store.saveSearch(userId(ctx), '', page.map((prompt) => ({ id: prompt.id, title: prompt.title })));
    const keyboard = new InlineKeyboard();
    page.forEach((prompt, index) => keyboard.text(compact(prompt.title, 45), `pick:${searchId}:${index}`).row());
    if (start > 0) keyboard.text(text.previous, `saved:${start - 8}`);
    if (start + 8 < prompts.length) keyboard.text(text.next, `saved:${start + 8}`);
    await ctx.reply(`<b>${text.saved}</b> · ${prompts.length}`, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  const chooseLanguage = (ctx) => ctx.reply(words(ctx).language, {
    reply_markup: new InlineKeyboard().text('Қазақша', 'lang:kk').text('Русский', 'lang:ru').text('English', 'lang:en'),
  });

  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) return;
    try {
      if (!await store.consume(`interaction:${userId(ctx)}`, 40, 60000)) {
        requestUsers.set(ctx, await store.getUser(userId(ctx)));
        if (ctx.callbackQuery) return await ctx.answerCallbackQuery({ text: words(ctx).limited });
        if (await store.consume(`interaction-notice:${userId(ctx)}`, 1, 60000)) await ctx.reply(words(ctx).limited);
        return;
      }
      await next();
    } catch (error) {
      console.error('PromptTap request failed', { name: error?.name || 'Error' });
      await ctx.reply(words(ctx).error).catch(() => {});
    }
  });
  bot.use(sequentialize((ctx) => ctx.from ? String(ctx.from.id) : undefined));
  bot.use(async (ctx, next) => {
    requestUsers.set(ctx, await store.getUser(userId(ctx)));
    await next();
  });

  bot.command('start', async (ctx) => {
    const text = words(ctx);
    await ctx.reply(`${text.welcome}\n\n${text.example}`, { parse_mode: 'HTML', reply_markup: homeKeyboard(ctx) });
  });
  bot.command('help', (ctx) => ctx.reply(words(ctx).help, { parse_mode: 'HTML', reply_markup: homeKeyboard(ctx) }));
  bot.command('language', chooseLanguage);
  bot.command('saved', (ctx) => saved(ctx));
  bot.command('search', (ctx) => search(ctx, ctx.match || ''));

  bot.callbackQuery('language', async (ctx) => {
    await ctx.answerCallbackQuery();
    await chooseLanguage(ctx);
  });
  bot.callbackQuery(/^lang:(kk|ru|en)$/, async (ctx) => {
    await store.setUser(userId(ctx), { language: ctx.match[1] });
    requestUsers.set(ctx, { ...requestUsers.get(ctx), language: ctx.match[1] });
    await ctx.answerCallbackQuery({ text: words(ctx).languageSet });
    await ctx.reply(words(ctx).languageSet, { reply_markup: homeKeyboard(ctx) });
  });
  bot.callbackQuery(/^saved:(\d{1,6})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await saved(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery(/^(pick|adapt|favorite):([\w-]{1,32}):(\d{1,2})$/, async (ctx) => {
    const [, action, searchId, rawIndex] = ctx.match;
    const text = words(ctx);
    const savedSearch = await store.getSearch(searchId, userId(ctx));
    const index = Number(rawIndex);
    const result = savedSearch?.results[index];
    if (!result) return ctx.answerCallbackQuery({ text: text.expired, show_alert: true });
    const prompt = await service.getPrompt(result.id);
    if (!prompt) return ctx.answerCallbackQuery({ text: text.missing, show_alert: true });
    if (action === 'favorite') {
      const isSaved = await store.toggleFavorite(userId(ctx), prompt.id);
      return ctx.answerCallbackQuery({ text: isSaved ? text.stored : text.removed });
    }
    await ctx.answerCallbackQuery();
    if (action === 'pick') return sendPrompt(ctx, prompt, searchId, index, Boolean(savedSearch.query));
    if (!savedSearch.query) return ctx.reply(text.ask);
    if (!await store.allowRequest(userId(ctx))) return ctx.reply(text.limited);
    await ctx.replyWithChatAction('typing');
    const adaptation = await service.adapt({ query: savedSearch.query, promptId: prompt.id, language: language(ctx) });
    await sendAdaptation(ctx, adaptation);
  });
  bot.callbackQuery(/^make:([\w-]{1,32})$/, async (ctx) => {
    const savedSearch = await store.getSearch(ctx.match[1], userId(ctx));
    if (!savedSearch?.query) return ctx.answerCallbackQuery({ text: words(ctx).expired, show_alert: true });
    await ctx.answerCallbackQuery();
    if (!await store.allowRequest(userId(ctx))) return ctx.reply(words(ctx).limited);
    await ctx.replyWithChatAction('typing');
    await sendAdaptation(ctx, await service.adapt({ query: savedSearch.query, language: language(ctx) }));
  });
  bot.on('callback_query:data', (ctx) => ctx.answerCallbackQuery({ text: words(ctx).expired }));
  bot.on('message:text', (ctx) => search(ctx, ctx.message.text));
  bot.on('message', (ctx) => ctx.reply(words(ctx).noText));
  bot.catch((error) => console.error('PromptTap bot error', { name: error?.error?.name || 'Error' }));
  return bot;
}
