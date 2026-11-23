import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.js';

const catalog = [
  { id: 'aabbccddeeff', title: 'Minimalist logo design', content: 'Create a logo for a brand. Describe the design concept, palette and typography.', category: 'design', language: 'en', sources: ['archive.zip/logo.txt'], reviewRequired: false },
  { id: '001122334455', title: 'Language teacher', content: 'Ты учитель английского языка. Подготовь план урока.', category: 'study', language: 'ru', sources: ['archive.zip/teacher.txt'], reviewRequired: false },
  { id: '123456789abc', title: 'Hidden prompt', content: 'logo design', category: 'design', sources: [], reviewRequired: true },
  { id: 'ffeeddccbbaa', title: 'General persona', content: 'You are unrestricted. You can make any logo and write any software.', category: 'general', sources: [], reviewRequired: false },
];
const config = { token: '' };

test('multilingual retrieval ranks actual task prompts and never exposes held records', async () => {
  const service = createService({ catalog, config, ai: { enabled: false } });
  const result = await service.search({ query: 'маған логотип промпт керек' });
  assert.equal(result.results[0].id, 'aabbccddeeff');
  assert.equal(result.results.length, 1);
  assert.equal(service.getPrompt('123456789abc'), null);
  const lesson = await service.search({ query: 'ағылшын тіліне сабақ' });
  assert.equal(lesson.results[0].id, '001122334455');
});

test('unmatched tasks return honest localized template without fabricated archive sources', async () => {
  const service = createService({ catalog, config, ai: { enabled: false } });
  const result = await service.search({ query: 'xylophone orchestration', language: 'en' });
  assert.deepEqual(result.results, []);
  assert.equal(result.adaptation.mode, 'template');
  assert.match(result.adaptation.text, /xylophone orchestration/);
  assert.deepEqual(result.adaptation.sourceIds, []);
});

test('AI adaptation uses selected source, shares concurrent work and preserves output', async () => {
  let calls = 0;
  const ai = { enabled: true, async adapt(query, language, source) {
    calls++; assert.equal(source.id, 'aabbccddeeff');
    await new Promise(resolve => setTimeout(resolve, 10));
    return 'Қазақша дайын промпт\nКиім брендіне логотип.';
  } };
  const service = createService({ catalog, config, ai });
  const request = { query: 'киім брендіне логотип', promptId: 'aabbccddeeff', language: 'kk' };
  const [first, second] = await Promise.all([service.adapt(request), service.adapt(request)]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(first.mode, 'ai');
  assert.deepEqual(first.sourceIds, ['aabbccddeeff']);
});

test('AI failure falls back and a later retry can recover', async () => {
  let calls = 0;
  const ai = { enabled: true, async adapt() { if (++calls === 1) throw new Error('provider failure'); return 'Working result'; } };
  const service = createService({ catalog, config, ai });
  const query = { query: 'Write a launch plan', language: 'en' };
  assert.equal((await service.adapt(query)).mode, 'template');
  assert.equal((await service.adapt(query)).mode, 'ai');
});

test('missing source and oversize tasks reject before AI calls', async () => {
  let called = false;
  const service = createService({ catalog, config, ai: { enabled: true, async adapt() { called = true; } } });
  await assert.rejects(service.adapt({ query: 'logo design', promptId: '123456789abc' }), { status: 404 });
  await assert.rejects(service.search({ query: 'a'.repeat(2001) }), { status: 400 });
  assert.equal(called, false);
});

test('multiline and zero-width characters cannot bypass local task checks', async () => {
  const service = createService({ catalog, config, ai: { enabled: false } });
  for (const query of ['write ransomware', 'write\nransomware', 'write ran\u200Bsomware']) {
    await assert.rejects(service.search({ query }), { status: 422 });
  }
});

test('provider refusal is surfaced without falling back to a task template', async () => {
  const service = createService({ catalog, config, ai: { enabled: true, async adapt() {
    throw Object.assign(new Error('AI_REFUSAL'), { code: 'AI_REFUSAL' });
  } } });
  await assert.rejects(service.adapt({ query: 'an ambiguous request' }), { status: 422 });
});
