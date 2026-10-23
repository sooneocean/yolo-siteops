import { describe, expect, it } from 'vitest';
import { loadConfig } from '../apps/server/config.js';

describe('server-only Codex command configuration', () => {
  it('accepts an absolute command path from the server environment', () => {
    const config = loadConfig({ SITEOPS_MODE: 'demo', SITEOPS_AGENT: 'codex', SITEOPS_CODEX_COMMAND: '/opt/siteops/bin/codex' });
    expect(config.codexCommand).toBe('/opt/siteops/bin/codex');
  });

  it.each(['', 'codex', './bin/codex'] as const)('rejects an empty or relative command without reflecting it: %j', (value) => {
    let received: unknown;
    try { loadConfig({ SITEOPS_MODE: 'demo', SITEOPS_CODEX_COMMAND: value }); }
    catch (error) { received = error; }
    expect(received).toBeInstanceOf(Error);
    expect((received as Error).message).toBe('The Codex command must be an absolute server-side path.');
    expect((received as Error).message).not.toContain(value || 'empty-command-canary');
  });

  it('leaves the command unset so the adapter retains its built-in fallback', () => {
    expect(loadConfig({ SITEOPS_MODE: 'demo' }).codexCommand).toBeUndefined();
  });
});
