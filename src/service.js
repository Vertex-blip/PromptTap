import { CatalogSearch, categories, detectCategory } from './search.js';

const instructions = {
  kk: {
    opening: 'Төмендегі тапсырма бойынша тәжірибелі маман ретінде жұмыс істе.',
    task: 'Тапсырма', result: 'Күтілетін нәтиже',
    end: 'Талаптарды сақта. Маңызды ақпарат жетіспесе, нақты сұрақ қой. Болжамды белгіле. Деректерді ойдан шығарма. Жауапты бірден пайдалануға дайын етіп бер.',
    fallback: 'ИИ бейімдеуі қазір қолжетімсіз. Тапсырмаға арналған үлгі дайындалды.',
    modes: { design: 'Концепция, композиция, түс палитрасы, стиль және қолдану форматын нақты сипатта.', code: 'Талаптарды, технологияларды, іске асыру қадамдарын, дайын кодты және тексеру тәсілін бер.', writing: 'Аудиторияға сәйкес дайын мәтінді, құрылымын және тілдік стилін ұсын.', marketing: 'Мақсатты аудитория, негізгі ұсыныс, жарнама мәтіні және әрекетке шақыру дайында.', study: 'Тақырыпты түсіндір, мысал көрсет, жаттығулар мен жауаптарын бер.', productivity: 'Нақты қадамдары, басымдықтары мен орындалу өлшемдері бар жоспар жаса.', security: 'Рұқсат берілген орта үшін аудит жоспарын, қорғаныс шараларын және түзетулерді ұсын.', general: 'Тапсырмаға сай нақты әрі толық нәтиже бер. Қажет жерде мысалдар мен қадамдарды көрсет.' },
  },
  ru: {
    opening: 'Работай как опытный специалист по следующей задаче.', task: 'Задача', result: 'Ожидаемый результат',
    end: 'Соблюдай требования. Если отсутствуют важные данные, задай конкретный вопрос. Обозначай допущения. Не выдумывай факты. Дай результат, готовый к использованию.',
    fallback: 'ИИ-адаптация сейчас недоступна. Подготовлен шаблон под задачу.',
    modes: { design: 'Опиши концепцию, композицию, палитру, стиль и формат использования.', code: 'Укажи требования, технологии, шаги реализации, готовый код и способ проверки.', writing: 'Подготовь готовый текст с подходящей структурой и стилем для аудитории.', marketing: 'Определи аудиторию, предложение, рекламный текст и призыв к действию.', study: 'Объясни тему, покажи примеры, дай упражнения с ответами.', productivity: 'Составь план с конкретными шагами, приоритетами и критериями выполнения.', security: 'Подготовь план аудита разрешенной среды, меры защиты и исправления.', general: 'Дай конкретный полный результат с примерами и шагами там, где они нужны.' },
  },
  en: {
    opening: 'Act as an experienced specialist for the following task.', task: 'Task', result: 'Expected result',
    end: 'Respect all requirements. Ask a specific question if essential information is missing. State assumptions. Do not fabricate facts. Deliver a ready-to-use result.',
    fallback: 'AI adaptation is currently unavailable. A task-specific template was prepared.',
    modes: { design: 'Specify the concept, composition, color palette, style, and intended format.', code: 'Provide requirements, technologies, implementation steps, working code, and verification steps.', writing: 'Produce finished copy with a structure and tone suited to the audience.', marketing: 'Define the audience, offer, ad copy, and call to action.', study: 'Explain the topic, show examples, and provide exercises with answers.', productivity: 'Create a plan with concrete steps, priorities, and completion criteria.', security: 'Provide an audit plan for an authorized environment, defenses, and remediation.', general: 'Provide a specific, complete result with examples and steps where appropriate.' },
  },
};

export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// A small local guard complements the model's own controls. Archive contents stay inert.
export function validateTask(query) {
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 2000) throw new UserError('Сұраныс 2–2000 таңба болуы керек. / Use 2–2000 characters.');
  const abuse = /(?:steal|ұрла|украсть|краж[аи]).{0,50}(?:password|парол|cookie|token|токен)|(?:create|build|write|жаз|жаса|созда|напиш).{0,50}(?:ransomware|stealer|вымогател|стилер)|(?:make|build|жаса|изготов|сделать).{0,40}(?:bomb|бомб|взрывчат)|(?:child|minor|реб[её]нок|несовершеннолет|бала).{0,50}(?:porn|порно)/iu;
  const normalized = query.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ');
  if (abuse.test(normalized)) throw new UserError('Қорғаныс, талдау немесе қауіпсіз оқу мақсатын сипаттаңыз. / Describe a defensive, analytical, or safe learning task.', 422);
  return query.trim();
}

export function createService({ catalog, ai, config, loadPrompt, catalogMetadata }) {
  const searchIndex = new CatalogSearch(catalog);
  const cache = new Map();
  const pending = new Map();
  const localized = language => instructions[language] || instructions.kk;
  const getPrompt = id => loadPrompt ? loadPrompt(id) : searchIndex.byId.get(id) || null;
  const service = {
    getPrompt,
    meta() {
      return {
        total: searchIndex.records.length, archiveTotal: catalog.length,
        reviewCount: catalog.filter(record => record.reviewRequired).length,
        categories: categories.map(id => ({ id, count: searchIndex.records.filter(record => record.category === id).length })),
        ...catalogMetadata,
        aiConfigured: ai.enabled, botConfigured: Boolean(config.token),
      };
    },
    async adapt({ query, promptId, language = 'kk' }) {
      query = validateTask(query);
      const source = promptId ? await getPrompt(promptId) : null;
      if (promptId && !source) throw new UserError('Промпт табылмады. / Prompt unavailable.', 404);
      const key = JSON.stringify([query, promptId, language]);
      if (cache.has(key)) return cache.get(key);
      if (pending.has(key)) return pending.get(key);
      const work = (async () => {
        if (ai.enabled) {
          try {
            const text = await ai.adapt(query, language, source);
            const result = { text, mode: 'ai', sourceIds: source ? [source.id] : [] };
            if (cache.size >= 150) cache.delete(cache.keys().next().value);
            cache.set(key, result);
            return result;
          } catch (error) {
            if (error.code === 'AI_REFUSAL') throw new UserError('ИИ бұл сұранысты өңдей алмады. Қауіпсіз мақсатын нақтылаңыз. / Clarify a safe purpose for this request.', 422);
            // A labeled local template remains available during provider outages.
          }
        }
        const t = localized(language);
        return {
          text: `${t.opening}\n\n${t.task}\n${query}\n\n${t.result}\n${t.modes[detectCategory(query)]}\n\n${t.end}`,
          mode: 'template', sourceIds: [], notice: t.fallback,
        };
      })();
      pending.set(key, work);
      try { return await work; } finally { pending.delete(key); }
    },
    async search({ query, language = 'kk', category }) {
      query = validateTask(query);
      let results = searchIndex.find(query, category);
      if (results.length === 0 && ai.enabled) {
        try { results = searchIndex.find(query, category, await ai.expand(query)); } catch { /* Local search and templates continue to work. */ }
      }
      if (results.length) return { query, results };
      const adaptation = await service.adapt({ query, language });
      return { query, results, adaptation, notice: adaptation.notice };
    },
  };
  return service;
}
