import { createPrivateKey, sign } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const PEM_PRIVATE_KEY = /^-----BEGIN PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PRIVATE KEY-----\r?\n?$/;
const keySchema = z.object({ client_email: z.string().email().max(320), private_key: z.string().min(128).max(32768).regex(PEM_PRIVATE_KEY) }).passthrough();
const tokenSchema = z.object({ access_token: z.string().min(1).max(16384), expires_in: z.number().int().min(60).max(86400) }).passthrough();
const SCOPES = { gsc: 'https://www.googleapis.com/auth/webmasters.readonly', ga4: 'https://www.googleapis.com/auth/analytics.readonly' } as const;

type GoogleSource = keyof typeof SCOPES | 'credentials' | 'authentication';
const SAFE_MESSAGES: Record<GoogleSource, string> = {
  credentials: 'The Google service account configuration is unavailable or unsafe.',
  authentication: 'Google authentication failed.',
  gsc: 'Search Console returned an invalid or unavailable response.',
  ga4: 'Google Analytics returned an invalid or unavailable response.',
};

export class SourceDataError extends Error {
  constructor(readonly source: GoogleSource, readonly code: string) {
    super(SAFE_MESSAGES[source]);
    this.name = 'SourceDataError';
  }
}

export function safeSourceMessage(source: 'gsc' | 'ga4', error: unknown): string {
  return error instanceof SourceDataError && (error.source === source || error.source === 'credentials' || error.source === 'authentication')
    ? error.message
    : SAFE_MESSAGES[source];
}

const finiteNonNegative = z.number().finite().nonnegative();
const gscRowSchema = z.object({
  keys: z.tuple([z.string().min(1).max(4096)]), clicks: finiteNonNegative, impressions: finiteNonNegative,
  ctr: finiteNonNegative, position: finiteNonNegative,
}).strict();
const siteSchema = z.object({ siteUrl: z.string().min(1).max(4096), permissionLevel: z.string().min(1).max(128) }).strict();
const sitesSchema = z.object({ siteEntry: z.array(siteSchema).max(1000).optional() }).passthrough();
const metricValueSchema = z.object({ value: z.string().min(1).max(128).refine(value => Number.isFinite(Number(value)) && Number(value) >= 0) }).strict();
const dimensionValueSchema = z.object({ value: z.string().max(4096) }).strict();
const gaMetadataSchema = z.object({
  timeZone: z.string().min(1).max(128).optional(), dataLossFromOtherRow: z.boolean().optional(),
  subjectToThresholding: z.boolean().optional(), samplingMetadatas: z.array(z.unknown()).max(100).optional(),
}).passthrough();
const gaRowSchema = z.object({
  dimensionValues: z.array(dimensionValueSchema).max(2).optional(), metricValues: z.array(metricValueSchema).min(1).max(4),
}).strict().transform(row => ({ ...row, dimensionValues: row.dimensionValues ?? [] }));
const gaReportSchema = z.object({
  rows: z.array(gaRowSchema).max(10000).optional(), rowCount: z.number().int().nonnegative().max(10_000_000).optional(),
  metadata: gaMetadataSchema.optional(),
}).passthrough();
const gaRequestSchema = z.object({
  dimensions: z.array(z.object({ name: z.string().min(1).max(128) }).passthrough()).max(2).optional(),
  metrics: z.array(z.object({ name: z.string().min(1).max(128) }).passthrough()).min(1).max(4),
}).passthrough();

export interface GscRow { keys: [string]; clicks: number; impressions: number; ctr: number; position: number; }
export interface GaRow { dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }>; }
export interface GaReport { rows?: GaRow[]; rowCount?: number; metadata?: { timeZone?: string; dataLossFromOtherRow?: boolean; subjectToThresholding?: boolean; samplingMetadatas?: unknown[] }; }

export class GoogleReader {
  private tokens = new Map<string, { token: string; expires: number }>();
  constructor(private keyPath: string, private fetchImpl: typeof fetch = fetch) {}

  private async credentials(): Promise<z.infer<typeof keySchema>> {
    try {
      if (!isAbsolute(this.keyPath)) throw new Error('relative path');
      const info = await lstat(this.keyPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('not regular');
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('unsafe permissions');
      const parsed = keySchema.parse(JSON.parse(await readFile(this.keyPath, 'utf8')));
      createPrivateKey(parsed.private_key);
      return parsed;
    } catch {
      throw new SourceDataError('credentials', 'credential_unavailable');
    }
  }

  private async token(kind: keyof typeof SCOPES): Promise<string> {
    const cached = this.tokens.get(kind);
    if (cached && cached.expires > Date.now() + 60000) return cached.token;
    const key = await this.credentials();
    try {
      const iat = Math.floor(Date.now() / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: key.client_email, scope: SCOPES[kind], aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 })}`;
      const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url')}`;
      const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      });
      if (!response.ok) throw new Error('authentication response');
      const payload = tokenSchema.parse(await response.json());
      this.tokens.set(kind, { token: payload.access_token, expires: Date.now() + payload.expires_in * 1000 });
      return payload.access_token;
    } catch (error) {
      if (error instanceof SourceDataError) throw error;
      throw new SourceDataError('authentication', 'authentication_failed');
    }
  }

  private async request<T>(kind: keyof typeof SCOPES, url: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, body?: unknown): Promise<T> {
    try {
      const response = await this.fetchImpl(url, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${await this.token(kind)}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error('upstream response');
      return schema.parse(await response.json());
    } catch (error) {
      if (error instanceof SourceDataError) throw error;
      throw new SourceDataError(kind, 'invalid_upstream_response');
    }
  }

  async sites(): Promise<Array<{ siteUrl: string; permissionLevel: string }>> {
    return (await this.request('gsc', 'https://www.googleapis.com/webmasters/v3/sites', sitesSchema)).siteEntry ?? [];
  }

  async search(site: string, startDate: string, endDate: string, dimensions: ['page'] | ['query'], page?: string): Promise<GscRow[]> {
    const limit = page ? 100 : 25000;
    const key = dimensions[0] === 'page' ? z.string().url().max(4096) : z.string().min(1).max(4096);
    const schema = z.object({ rows: z.array(gscRowSchema.extend({ keys: z.tuple([key]) })).max(limit).optional() }).passthrough();
    const result = await this.request('gsc', `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, schema, {
      startDate, endDate, dimensions, type: 'web', dataState: 'final', rowLimit: limit,
      ...(page ? { dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: page }] }] } : {}),
    });
    return result.rows ?? [];
  }

  async report(property: string, request: unknown): Promise<GaReport> {
    const parsedRequest = gaRequestSchema.safeParse(request);
    if (!parsedRequest.success) throw new SourceDataError('ga4', 'invalid_report_request');
    const dimensionCount = parsedRequest.data.dimensions?.length ?? 0;
    const metricCount = parsedRequest.data.metrics.length;
    const result = await this.request('ga4', `https://analyticsdata.googleapis.com/v1beta/properties/${property.replace(/^properties\//, '')}:runReport`, gaReportSchema, request);
    if (result.rows?.some(row => row.dimensionValues.length !== dimensionCount || row.metricValues.length !== metricCount)) {
      throw new SourceDataError('ga4', 'invalid_report_tuple');
    }
    return result;
  }

  async measurement(property: string, startDate: string, endDate: string, hostname: string): Promise<boolean> {
    const result = await this.report(property, { dateRanges: [{ startDate, endDate }], dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }, { name: 'keyEvents' }], dimensionFilter: { andGroup: { expressions: [
      { filter: { fieldName: 'eventName', inListFilter: { values: ['first_visit', 'page_view', 'session_start'] } } },
      { filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: hostname } } },
    ] } } });
    if (result.rows?.some(row => row.dimensionValues.length !== 1 || row.metricValues.length !== 2)) throw new SourceDataError('ga4', 'invalid_measurement_tuple');
    return Boolean(result.rows?.length) && result.rows!.every(row => Number(row.metricValues[1].value) === 0) && !result.metadata?.subjectToThresholding && !result.metadata?.dataLossFromOtherRow && !(result.metadata?.samplingMetadatas?.length);
  }

  async landingPages(property: string, startDate: string, endDate: string, hostname: string): Promise<GaReport> {
    const result = await this.report(property, { dateRanges: [{ startDate, endDate }], dimensions: [{ name: 'landingPage' }], metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }], limit: '10000', dimensionFilter: { andGroup: { expressions: [
      { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'Organic Search' } } },
      { filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: hostname } } },
    ] } } });
    if (result.rows?.some(row => row.dimensionValues.length !== 1 || row.metricValues.length !== 2)) throw new SourceDataError('ga4', 'invalid_landing_tuple');
    return result;
  }
}

export function completeWindows(now = new Date()): { startDate: string; endDate: string; previousStart: string; previousEnd: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  const current = Date.parse(`${get('year')}-${get('month')}-${get('day')}T12:00:00Z`);
  const day = (offset: number) => new Date(current - offset * 86400000).toISOString().slice(0, 10);
  return { startDate: day(30), endDate: day(3), previousStart: day(58), previousEnd: day(31) };
}
