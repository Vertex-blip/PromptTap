import MiniSearch from 'minisearch';

export const categories = ['design', 'code', 'writing', 'marketing', 'study', 'productivity', 'security', 'general'];
const concepts = [
  ['design', /дизайн|логотип|logo|brand|сурет|image|picture|illustrat|визуал|midjourney|фото|photo|render|интерьер/iu, 'design logo brand image illustration photo render логотип дизайн сурет'],
  ['code', /код|code|coding|program|программ|бағдарлам|сайт|website|python|javascript|react|telegram|телега|бот|debug/iu, 'code programming developer код программирование разработчик'],
  ['writing', /мәтін|текст|жаз|жазу|write|writing|story|статья|article|әңгіме|перевод|аудар|translat|эссе/iu, 'writing text writer текст копирайтер перевод'],
  ['marketing', /маркет|market|жарнама|реклама|advert|instagram|инста|продаж|сату|sales|smm|seo/iu, 'marketing advertising sales маркетинг реклама продажи'],
  ['study', /оқу|сабақ|учеб|учёб|обуч|изуч|study|learn|lesson|teacher|репетитор|математ|math|емтихан|экзамен/iu, 'study learning teacher education обучение учеба преподаватель'],
  ['productivity', /жоспар|план|plan|productiv|schedule|резюме|resume|meeting|жұмыс|workflow|задач/iu, 'productivity planning plan assistant план задачи помощник'],
  ['security', /аудит|audit|security|безопас|қорған|қауіпсіз|defense|защит|vulnerab|осалдық/iu, 'security audit defense безопасность защита аудит'],
  ['general', /jailbreak|unfilter|unrestricted|шектеу|отмена|отказ|без огранич|цензур|цензура|dan\b/iu, 'jailbreak unfiltered unrestricted restrictions refusal отказы ограничения'],
];
const stopWords = new Set(('маған үшін керек бер берші промпт промт маған осындай керекші жаса жасау керек please prompt prompts for the a an to of and with my me give need want для мне промпт промт дай нужен нужна нужно как чтобы сделай').split(' '));
for (const word of 'in on at as be is are this that it from you write create build working мен менің маған жазып қалай и на в по из с про это написать создать'.split(' ')) stopWords.add(word);
const topicGroups = [
  ['logo', 'логотип'], ['image', 'picture', 'сурет', 'изображен'], ['photo', 'фото'],
  ['design', 'дизайн'], ['code', 'coding', 'код', 'программ', 'бағдарлам'],
  ['website', 'landing', 'сайт', 'лендинг'], ['english', 'английск', 'ағылшын'],
  ['study', 'learn', 'lesson', 'оқу', 'сабақ', 'обуч', 'учеб', 'учёб'],
  ['marketing', 'маркетинг'], ['advert', 'жарнама', 'реклама'],
  ['letter', 'email', 'хат', 'письм'], ['resume', 'резюме'],
  ['plan', 'план', 'жоспар'], ['story', 'әңгіме', 'рассказ'],
  ['translate', 'перевод', 'аудар'], ['security', 'безопас', 'қауіпсіз'],
  ['jailbreak', 'unfiltered', 'unrestricted', 'шектеу', 'отмена', 'отказ', 'цензур'],
];
export function normalize(text) { return text.toLowerCase().normalize('NFKC').replace(/ё/g, 'е'); }
export function terms(text) { return normalize(text).match(/[\p{L}\p{N}]{2,}/gu)?.filter(term => !stopWords.has(term)) || []; }
export function detectCategory(query) { return concepts.find(([, pattern]) => pattern.test(query))?.[0] || 'general'; }

export class CatalogSearch {
  constructor(records) {
    this.records = records.filter(record => !record.reviewRequired);
    this.byId = new Map(this.records.map(record => [record.id, record]));
    this.index = new MiniSearch({
      fields: ['title', 'content'], storeFields: ['id'],
      tokenize: terms,
      searchOptions: { boost: { title: 5 }, prefix: true, fuzzy: 0.15 },
    });
    this.index.addAll(this.records.map(record => ({ id: record.id, title: record.title, content: record.content.slice(0, 16000) })));
  }
  find(query, category, translatedTerms = '') {
    const matches = concepts.filter(([, pattern]) => pattern.test(query));
    const original = terms(query);
    const queryText = normalize(`${query} ${translatedTerms}`);
    const topics = topicGroups.filter(group => group.some(term => queryText.includes(term)));
    const expanded = [...new Set([...original, ...terms(translatedTerms), ...topics.flat()])].slice(0, 60);
    if (!expanded.length) return [];
    const queryTerms = terms(`${query} ${translatedTerms}`);
    const candidates = this.index.search(expanded.join(' '));
    return candidates.map(result => {
      const record = this.byId.get(result.id);
      const title = normalize(record.title);
      const opening = normalize(record.content.slice(0, 1200));
      const titleHits = queryTerms.filter(term => title.includes(term)).length;
      const contentHits = queryTerms.filter(term => opening.includes(term)).length;
      const topicHits = topics.filter(group => group.some(term => opening.includes(term) || title.includes(term))).length;
      const specificTopics = topics.filter(group => !group.includes('code') && !group.includes('study') && !group.includes('design'));
      const specificMatch = specificTopics.length === 0 || specificTopics.some(group => group.some(term => opening.includes(term) || title.includes(term)));
      const categoryMatch = matches.some(([id]) => id === record.category);
      // Require real overlap, so a broad role prompt is not a match for every task.
      const nameMatch = titleHits > 0;
      const generalPersona = /god mode|unrestricted|unfiltered|jailbreak|you are chatgpt|ignore (all|previous)|никогда не отказыва|без ограничений/iu.test(record.content.slice(0, 2000));
      const bypassQuery = matches.some(([id]) => id === 'general');
      const requestedCategories = matches.filter(([id]) => id !== 'general');
      const topicalCategory = requestedCategories.length === 0 || categoryMatch || nameMatch;
      const technologies = original.filter(term => /^(react|python|javascript|typescript|vue|django|sql|rust|golang)$/.test(term));
      const technologyMatch = technologies.every(term => normalize(record.content.slice(0, 16000)).includes(term));
      const relevant = topicalCategory && technologyMatch && specificMatch && (!generalPersona || bypassQuery || nameMatch) &&
        (nameMatch || contentHits >= Math.min(2, queryTerms.length) || topicHits > 0);
      const score = result.score + titleHits * 15 + contentHits * 2 + topicHits * 10 + (categoryMatch ? 4 : 0);
      return { record, score, relevant };
    }).filter(item => item.relevant && (!category || category === 'all' || item.record.category === category))
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
      .slice(0, 3).map(({ record, score }) => ({
        id: record.id, title: record.title,
        description: record.content.replace(/[#*`<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 170),
        category: record.category, language: record.language, score: Math.round(score * 10) / 10,
        sourceCount: record.sources.length,
      }));
  }
}
