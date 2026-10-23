import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type LiveConfig } from '../apps/server/config.js';
import { GoogleReader } from '../apps/server/data/google.js';
import { LiveDataProvider } from '../apps/server/data/provider.js';
import type { WordPressAdapter } from '../apps/server/writer/types.js';

const CANARY = 'secret-canary-token-and-path';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function serviceAccount(mode = 0o600): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'siteops-data-security-'));
  roots.push(root);
  const keyPath = path.join(root, `credential-${CANARY}.json`);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await fs.writeFile(keyPath, JSON.stringify({
    type: 'service_account', project_id: 'legitimate-extra-field', private_key_id: 'also-allowed',
    client_email: 'reader@example.test', private_key: privateKey, token_uri: 'https://oauth2.googleapis.com/token',
  }), { mode });
  await fs.chmod(keyPath, mode);
  return keyPath;
}

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('bounded external data', () => {
  it('accepts standard service-account metadata but sanitizes malformed GSC data', async () => {
    const keyPath = await serviceAccount();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ access_token: CANARY, expires_in: 3600, token_type: 'Bearer' }))
      .mockResolvedValueOnce(response({ rows: [{ keys: ['https://example.test/page'], clicks: CANARY, impressions: 20, ctr: 0.1, position: 4 }] }))
      .mockResolvedValueOnce(response({ access_token: 'separate-ga-token', expires_in: 3600 }))
      .mockResolvedValueOnce(response({ rows: [{ dimensionValues: [{ value: '/' }], metricValues: [{ value: CANARY }, { value: '4' }] }] })) as unknown as typeof fetch;
    const reader = new GoogleReader(keyPath, fetchImpl);
    await expect(reader.search('sc-domain:example.test', '2026-01-01', '2026-01-02', ['page'])).rejects.toSatisfy((error: Error) => {
      const serialized = `${error.name}:${error.message}`;
      return !serialized.includes(CANARY) && !serialized.includes(keyPath) && serialized.includes('Search Console');
    });
    await expect(reader.landingPages('1234', '2026-01-01', '2026-01-02', 'example.test')).rejects.toSatisfy((error: Error) => {
      const serialized = `${error.name}:${error.message}`;
      return !serialized.includes(CANARY) && !serialized.includes(keyPath) && serialized.includes('Google Analytics');
    });
  });

  it('enforces the 100-row cap for page-filtered query responses', async () => {
    const keyPath = await serviceAccount();
    const row = { keys: ['query'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ access_token: 'bounded-test-token', expires_in: 3600 }))
      .mockResolvedValueOnce(response({ rows: Array.from({ length: 101 }, () => row) })) as unknown as typeof fetch;
    const reader = new GoogleReader(keyPath, fetchImpl);
    await expect(reader.search('sc-domain:example.test', '2026-01-01', '2026-01-02', ['query'], 'https://example.test/page'))
      .rejects.toThrow('Search Console returned an invalid or unavailable response.');
  });

  it('accepts a metrics-only GA response with no dimensionValues and still enforces exact tuples', async () => {
    const keyPath = await serviceAccount();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ access_token: 'metrics-only-token', expires_in: 3600 }))
      .mockResolvedValueOnce(response({ rows: [{ metricValues: [{ value: '7' }] }], rowCount: 1, metadata: { timeZone: 'UTC' } }))
      .mockResolvedValueOnce(response({ rows: [{ dimensionValues: [{ value: 'unexpected' }], metricValues: [{ value: '7' }] }] })) as unknown as typeof fetch;
    const reader = new GoogleReader(keyPath, fetchImpl);
    await expect(reader.report('1234', { metrics: [{ name: 'sessions' }], limit: '1' })).resolves.toMatchObject({
      rows: [{ dimensionValues: [], metricValues: [{ value: '7' }] }],
    });
    await expect(reader.report('1234', { metrics: [{ name: 'sessions' }], limit: '1' }))
      .rejects.toThrow('Google Analytics returned an invalid or unavailable response.');
  });

  it('rejects unsafe credential permissions without exposing the file path', async () => {
    if (process.platform === 'win32') return;
    const keyPath = await serviceAccount(0o644);
    const root = path.dirname(keyPath);
    const configPath = path.join(root, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      siteUrl: 'https://example.test', username: 'reader', appPassword: CANARY,
      gscSiteUrl: 'sc-domain:example.test', googleServiceAccountKeyPath: keyPath,
    }));
    expect(() => loadConfig({ SITEOPS_MODE: 'live', SITEOPS_CONFIG_PATH: configPath })).toThrowError(expect.objectContaining({
      message: expect.not.stringContaining(keyPath),
    }));
  });

  it('never copies provider exceptions or malformed WordPress payloads into connection state', async () => {
    const config: LiveConfig = {
      siteUrl: 'https://example.test', username: 'reader', appPassword: CANARY,
      gscSiteUrl: 'sc-domain:example.test', ga4PropertyId: '1234',
    };
    const wordpress: WordPressAdapter = {
      getPostForEdit: vi.fn(async () => { throw new Error(CANARY); }),
      updateBody: vi.fn(async () => undefined),
      checkPublicReadback: vi.fn(async () => { throw new Error(CANARY); }),
    };
    const google = {
      sites: vi.fn(async () => { throw new Error(CANARY); }),
      search: vi.fn(async () => []), report: vi.fn(async () => { throw new Error(CANARY); }),
      measurement: vi.fn(async () => false), landingPages: vi.fn(async () => ({ rows: [] })),
    };
    const provider = new LiveDataProvider(config, wordpress, () => undefined, {
      google,
      fetch: vi.fn(async () => { throw new Error(CANARY); }) as unknown as typeof fetch,
    });
    const state = JSON.stringify(await provider.check());
    expect(state).not.toContain(CANARY);
    expect(state).not.toContain('reader');
  });

  it('rejects malformed WordPress slug candidates with a fixed safe error', async () => {
    const config: LiveConfig = {
      siteUrl: 'https://example.test', username: 'reader', appPassword: CANARY, gscSiteUrl: 'sc-domain:example.test',
    };
    let searches = 0;
    const google = {
      sites: vi.fn(async () => []),
      search: vi.fn(async () => (++searches === 1 ? [{ keys: ['https://example.test/page'] as [string], clicks: 10, impressions: 200, ctr: 0.05, position: 5 }] : [])),
      report: vi.fn(async () => ({})), measurement: vi.fn(async () => false), landingPages: vi.fn(async () => ({})),
    };
    const wordpress = { getPostForEdit: vi.fn(), updateBody: vi.fn(), checkPublicReadback: vi.fn() } as unknown as WordPressAdapter;
    const provider = new LiveDataProvider(config, wordpress, () => undefined, {
      google,
      fetch: vi.fn(async () => response([{ id: 4, link: `https://example.test/page?${CANARY}`, injected: CANARY }])) as unknown as typeof fetch,
    });
    await expect(provider.sync()).rejects.toSatisfy((error: Error) => error.message === 'WordPress returned an invalid or unavailable response.' && !error.message.includes(CANARY));
  });
});
