import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { parseEnv } from 'node:util';

const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const exampleEnv = /(?:^|\.)(?:example|sample|template)$/i;
const privateEnv = path => /(^|\/)\.env(?:\.[^/]*)?$/i.test(path) && !exampleEnv.test(path);
const sensitivePath = /\.sqlite(?:-wal|-shm)?$|(^|\/)data\/catalog\.json$|\.(rar|zip)$/i;
const credentials = /\b\d{8,12}:[A-Za-z0-9_-]{32,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b|\bAIza[A-Za-z0-9_-]{30,}\b|\bAQ\.[A-Za-z0-9_-]{30,}\b|\bsb_secret_[A-Za-z0-9_-]{20,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const secretName = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|SERVICE_ROLE_KEY)$/i;
const placeholder = /^(?:(?:test|fixture|fake|dummy|example|placeholder)(?:[-_].*)?|your[-_].*|replace[-_]me|change[-_]me|<[^>]*>)$/i;
const localSecrets = new Set();
function collectSecrets(values) {
  for (const [name, value] of Object.entries(values)) {
    if (secretName.test(name) && typeof value === 'string' && value.length >= 8 && !placeholder.test(value)) {
      localSecrets.add(value);
    }
  }
}
// Read private values only into memory; diagnostics never include matching text.
// Test files are scanned too. Only explicit placeholder values are excluded.
for (const path of readdirSync('.', { withFileTypes: true })) {
  if (path.isFile() && privateEnv(path.name)) collectSecrets(parseEnv(readFileSync(path.name, 'utf8')));
}
collectSecrets(process.env);
let failed = false;
for (const path of paths) {
  if (privateEnv(path) || sensitivePath.test(path)) { console.error(`Private file tracked: ${path}`); failed = true; continue; }
  if (!existsSync(path)) continue; // A tracked file may have been deleted locally.
  if (/\.(png|jpe?g|ico|woff2?)$/i.test(path)) continue;
  const content = readFileSync(path, 'utf8');
  if (credentials.test(content) || [...localSecrets].some(secret => content.includes(secret))) {
    console.error(`Possible credential in: ${path}`); failed = true;
  }
}
if (failed) process.exit(1);
console.log(`Secret scan passed for ${paths.length} tracked files.`);
