import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const sensitivePath = /(^|\/)\.env$|\.sqlite(?:-wal|-shm)?$|(^|\/)data\/catalog\.json$|\.(rar|zip)$/i;
const credentials = /\b\d{8,12}:[A-Za-z0-9_-]{32,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
let failed = false;
for (const path of paths) {
  if (sensitivePath.test(path)) { console.error(`Private file tracked: ${path}`); failed = true; continue; }
  if (/\.(png|jpe?g|ico|woff2?)$/i.test(path)) continue;
  if (credentials.test(readFileSync(path, 'utf8'))) { console.error(`Possible credential in: ${path}`); failed = true; }
}
if (failed) process.exit(1);
console.log(`Secret scan passed for ${paths.length} tracked files.`);
