import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { Mode } from '../../packages/contracts.js';

const configSchema = z.object({
  siteUrl: z.string().url(), username: z.string().min(1), appPassword: z.string().min(1),
  gscSiteUrl: z.string().min(1).optional(), ga4PropertyId: z.string().regex(/^(properties\/)?\d+$/).optional(),
  googleServiceAccountKeyPath: z.string().optional(), writerLockPath: z.string().optional(),
}).strip();
export type LiveConfig = z.infer<typeof configSchema>;
export interface Config { mode: Mode; port: number; dataDir: string; live?: LiveConfig; agent: 'demo' | 'codex'; codexCommand?: string; }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = z.enum(['demo', 'live']).parse(env.SITEOPS_MODE ?? 'demo');
  const agent = z.enum(['demo', 'codex']).parse(env.SITEOPS_AGENT ?? (mode === 'live' ? 'codex' : 'demo'));
  const port = z.coerce.number().int().min(1024).max(65535).parse(env.SITEOPS_PORT ?? '4317');
  const dataDir = resolve(env.SITEOPS_DATA_DIR ?? '.siteops', mode);
  const codexCommand = env.SITEOPS_CODEX_COMMAND;
  if (codexCommand !== undefined && (!codexCommand || !isAbsolute(codexCommand))) {
    throw new Error('The Codex command must be an absolute server-side path.');
  }
  const commandConfig = codexCommand === undefined ? {} : { codexCommand };
  if (mode === 'demo') return { mode, port, dataDir, agent, ...commandConfig };
  if (!env.SITEOPS_CONFIG_PATH) throw new Error('Live mode requires SITEOPS_CONFIG_PATH pointing to a private server-side JSON configuration.');
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(env.SITEOPS_CONFIG_PATH, 'utf8')); }
  catch { throw new Error('Cannot read the private connection configuration. No secrets were logged.'); }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid connection configuration fields: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`);
  const url = new URL(parsed.data.siteUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('WordPress must be a fixed HTTPS origin without credentials, ports, path, or redirects.');
  }
  if (parsed.data.googleServiceAccountKeyPath) {
    try {
      if (!isAbsolute(parsed.data.googleServiceAccountKeyPath)) throw new Error('relative');
      const info = lstatSync(parsed.data.googleServiceAccountKeyPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('not regular');
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('unsafe permissions');
    } catch {
      throw new Error('The Google service account file must be an absolute regular file with no group or other permissions.');
    }
  }
  return { mode, port, dataDir, live: { ...parsed.data, siteUrl: url.origin }, agent, ...commandConfig };
}
