import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archivePath = resolve(process.argv[2] || join(projectRoot, 'jail_ai.rar'));
const outputDirectory = join(projectRoot, 'data');
const rawPath = join(outputDirectory, '.import-raw.ndjson');
const reportPath = join(outputDirectory, '.import-traversal.json');
const lockPath = join(outputDirectory, '.import.lock');

function languageOf(content) {
  const sample = content.slice(0, 20000);
  if ((sample.match(/[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/g) || []).length > 5) return 'kk';
  if ((sample.match(/[а-яё]/gi) || []).length > 20) return 'ru';
  if ((sample.match(/[a-z]/gi) || []).length > 20) return 'en';
  return 'other';
}

function categoryOf(title, content) {
  const sample = `${title} ${content.slice(0, 3000)}`.toLowerCase();
  const categories = [
    ['security', /cybersecurity|penetration test|security audit|threat model|кибербезопас|аудит.*безопас|защита.*данных/],
    ['design', /logo design|graphic design|midjourney|stable diffusion|dall.e|логотип|дизайн|рендер|изображени|photograph/],
    ['marketing', /marketing|copywrit|social media|маркетинг|реклам|копирайт|sales funnel/],
    ['code', /programming|developer|write code|python|javascript|разработчик|программирован|кодирован|\bc\+\+\b/],
    ['writing', /creative writ|storytell|novelist|screenwrit|писатель|рассказ|стихотвор|сценарист/],
    ['study', /tutor|curriculum|lesson plan|учитель|репетитор|обучени|изучени/],
    ['productivity', /productivity|project manag|time manag|продуктивност|планирован|тайм.менедж/],
  ];
  return categories.find(([, pattern]) => pattern.test(sample))?.[0] || 'general';
}

// These indicators queue source material for human review before public retrieval.
// They are triage indicators, not a claim that the remaining content has been vetted.
function needsReview(content) {
  const reviewIndicators = [
    /ransomware|credential.{0,30}(?:steal|harvest)|(?:steal|harvest).{0,30}(?:password|credential|cookie)|infostealer|keylogger|phishing|malware|botnet|ddos|reverse shell|meterpreter|mimikatz|вредонос|фишинг|стилер|шифровальщик|краж.{0,25}(?:парол|кук|данных)|(?:взлом|взломать).{0,30}(?:аккаунт|кошел|сайт|систем)/is,
    /(?:create|write|develop|build|deploy|создай|напиши|разработай|создавать).{0,80}(?:trojan|virus|exploit|backdoor|spyware|вирус|троян|эксплойт|бекдор)|(?:bypass|evade|disable).{0,30}(?:antivirus|\bEDR\b|\bAMSI\b)/is,
    /explosive|bomb.{0,30}(?:make|build|recipe)|(?:make|build).{0,30}bomb|взрывчат|сборк.{0,20}бомб|\bTATP\b|nitroglycerin|нитроглицерин|тротил|биооруж|bioweapon|(?:чертеж|изготов|сдела).{0,35}(?:оружи|пистолет)/is,
    /наркотик|methamphetamine|synthesi[sz]e.{0,30}(?:drug|fentanyl|meth)|синтез.{0,25}(?:амфет|метамф|фентан)/is,
    /child sexual|sexual.{0,25}(?:minor|child)|(?:minor|child).{0,25}(?:sexual|porn)|детск.{0,20}порн|несовершеннолетн.{0,35}(?:секс|порн)|\b(?:loli|lolicon|shota|shotacon|pedoph\w*|incest|hentai|porn\w*|erotica)\b|педоф|лоликон|инцест|порн|эротик/is,
    /\b(?:cock|pussy)\b|(?:explicit|erotic|aroused|arousal).{0,120}(?:penis|vagina|nipples|genitals)|(?:genitals|vagina|nipples).{0,120}(?:atlas|visible|exposed|spread)/is,
    /suicide.{0,20}(?:method|instruction)|(?:how to|способ).{0,20}(?:suicide|самоубий)/is,
  ];
  return reviewIndicators.some((indicator) => indicator.test(content));
}

async function exportArchive() {
  const script = join(projectRoot, 'scripts', 'export-archive.ps1');
  await new Promise((accept, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-File', script, '-ArchivePath', archivePath, '-OutputPath', rawPath, '-ReportPath', reportPath], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? accept() : reject(new Error(`Archive extraction failed with exit code ${code}`)));
  });
}

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('An archive import is already running. If it was interrupted, remove data/.import.lock before retrying.');
    throw error;
  }
  try { await importCatalog(); }
  finally { await lock.close(); await rm(lockPath, { force: true }); }
}

async function importCatalog() {
  await exportArchive();
  const records = new Map();
  const lines = createInterface({ input: createReadStream(rawPath), crlfDelay: Infinity });
  let duplicateFiles = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    const normalized = entry.content.replace(/\r\n?/g, '\n').trim();
    const hash = createHash('sha256').update(normalized).digest('hex');
    const existing = records.get(hash);
    if (existing) {
      existing.sources.push(entry.source);
      duplicateFiles++;
      continue;
    }
    const title = entry.name.replace(/\.(txt|md|mkd|markdown|json|csv)$/i, '').trim();
    records.set(hash, {
      id: hash.slice(0, 12), title, content: entry.content,
      sources: [entry.source], language: languageOf(entry.content),
      category: categoryOf(title, entry.content), reviewRequired: needsReview(entry.content),
    });
  }
  const catalog = [...records.values()];
  const traversal = JSON.parse((await readFile(reportPath, 'utf8')).replace(/^\uFEFF/, ''));
  const report = {
    importedAt: new Date().toISOString(), archive: archivePath,
    ...traversal, uniquePrompts: catalog.length, duplicateFiles,
    reviewRequired: catalog.filter((entry) => entry.reviewRequired).length,
    availableBeforeReview: catalog.filter((entry) => !entry.reviewRequired).length,
    categories: Object.fromEntries([...new Set(catalog.map((entry) => entry.category))].map((category) => [category, catalog.filter((entry) => entry.category === category).length])),
    languages: Object.fromEntries([...new Set(catalog.map((entry) => entry.language))].map((language) => [language, catalog.filter((entry) => entry.language === language).length])),
    notes: ['UTF-8, UTF-16 BOM and Windows-1251 text decoding supported.', 'All non-media entries are checked for readable text, including extensionless prompts, Markdown, JSON, CSV and source-code files. Structured files are retained verbatim.', 'Duplicate detection normalizes line endings and surrounding whitespace. Original first-file text is preserved.', 'Review flags are heuristic triage. Unflagged content has not been manually reviewed.'],
  };
  await writeFile(join(outputDirectory, 'catalog.json.tmp'), JSON.stringify(catalog), 'utf8');
  await rename(join(outputDirectory, 'catalog.json.tmp'), join(outputDirectory, 'catalog.json'));
  await writeFile(join(outputDirectory, 'import-report.json.tmp'), JSON.stringify(report, null, 2), 'utf8');
  await rename(join(outputDirectory, 'import-report.json.tmp'), join(outputDirectory, 'import-report.json'));
  await rm(rawPath);
  await rm(reportPath);
  console.log(JSON.stringify({ uniquePrompts: report.uniquePrompts, duplicateFiles, reviewRequired: report.reviewRequired, availableBeforeReview: report.availableBeforeReview, skippedFiles: report.skipped.length }, null, 2));
}

main().catch((error) => {
  console.error(`Import failed: ${error.message}`);
  process.exitCode = 1;
});
