import { readFile } from 'node:fs/promises';

const base = process.env.SUPABASE_URL;
const secret = process.env.APP_STORE_SECRET;
if (!base || !secret || secret.length < 32) throw new Error('Configure SUPABASE_URL and APP_STORE_SECRET in the private environment.');
const endpoint = new URL('/functions/v1/prompttap/admin/catalog', base);
if (endpoint.protocol !== 'https:') throw new Error('HTTPS is required.');
const records = JSON.parse(await readFile(`${process.env.DATA_DIR || './data'}/catalog.json`, 'utf8'));
let batch = [], bytes = 0, completed = 0;
async function send() {
  if (!batch.length) return;
  const body = JSON.stringify({ records: batch });
  // Upserts are idempotent, so interrupted catalog imports can safely be retried.
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PromptTap-Admin-Key': secret },
        body, signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`Catalog upload failed (HTTP ${response.status}).`);
      const result = await response.json();
      if (result.imported !== batch.length) throw new Error('Catalog upload count mismatch.');
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  completed += batch.length;
  console.log(`Imported ${completed}/${records.length}`);
  batch = []; bytes = 0;
}
for (const record of records) {
  const length = Buffer.byteLength(JSON.stringify(record));
  if (batch.length >= 30 || (batch.length && bytes + length > 1000000)) await send();
  batch.push(record); bytes += length;
}
await send();
const response = await fetch(endpoint, { headers: { 'X-PromptTap-Admin-Key': secret }, signal: AbortSignal.timeout(20000) });
if (!response.ok) throw new Error(`Catalog verification failed (HTTP ${response.status}).`);
const meta = await response.json();
if (meta.archiveTotal !== records.length) throw new Error('Catalog total mismatch.');
console.log(JSON.stringify(meta));
