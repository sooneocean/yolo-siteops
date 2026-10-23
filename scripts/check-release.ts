import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const failures: Array<{ file: string; rule: string }> = [];
const rules: Array<[string, RegExp]> = [
  ['private-key-material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=]{40,}/],
  ['personal-workspace-path', /\/Users\/[a-z][a-z0-9_-]*\//i],
  ['access-token-value', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AIza[A-Za-z0-9_-]{30,})\b/],
  ['google-service-account-material', /"type"\s*:\s*"service_account"/],
];
for (const file of [...new Set(paths)]) {
  const fullPath = resolve(root, file);
  if (relative(root, fullPath).startsWith('..')) throw new Error('Release inventory escaped repository');
  if (/(^|\/)(?:\.env(?:\.|$)|\.siteops|work|test-results|playwright-report|node_modules|credentials|backups)(?:\/|$)|\.(?:sqlite(?:-wal|-shm)?|db|pem|key)$/i.test(file)) {
    failures.push({ file, rule: 'private-or-generated-file' }); continue;
  }
  const stat = lstatSync(fullPath);
  if (stat.isSymbolicLink()) { failures.push({ file, rule: 'symlink-not-reviewed' }); continue; }
  if (!stat.isFile() || stat.size > 2_000_000) { failures.push({ file, rule: 'unexpected-file-type-or-size' }); continue; }
  const content = readFileSync(fullPath, 'utf8');
  if (content.includes('\0')) { failures.push({ file, rule: 'binary-not-reviewed' }); continue; }
  // This scanner contains the patterns themselves, never a real secret.
  if (file === 'scripts/check-release.ts') continue;
  for (const [rule, pattern] of rules) if (pattern.test(content)) failures.push({ file, rule });
}
if (failures.length) {
  console.error(JSON.stringify({ status: 'blocked', failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: 'inventory-check-passed', files: new Set(paths).size,
    limitation: 'Heuristic source inventory check only. Independent review and all live E2E gates remain required before release.' }, null, 2));
}
