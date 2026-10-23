import { randomUUID } from 'node:crypto';
import type { Connection, Snapshot, PageRecord, SearchRow, SearchPageRow, AnalyticsRow } from '../../../packages/contracts.js';
import type { LiveConfig } from '../config.js';
import type { WordPressAdapter, WordPressPostSnapshot } from '../writer/types.js';
import { hashPostState } from '../writer/hash.js';
import { z } from 'zod';
import { GoogleReader, completeWindows, safeSourceMessage, type GaReport, type GscRow } from './google.js';

export interface DataProvider {
  check(): Promise<Connection[]>;
  sync(): Promise<Snapshot>;
}
interface GoogleDataReader {
  sites(): Promise<Array<{ siteUrl: string; permissionLevel: string }>>;
  search(site: string, startDate: string, endDate: string, dimensions: ['page'] | ['query'], page?: string): Promise<GscRow[]>;
  report(property: string, request: unknown): Promise<GaReport>;
  measurement(property: string, startDate: string, endDate: string, hostname: string): Promise<boolean>;
  landingPages(property: string, startDate: string, endDate: string, hostname: string): Promise<GaReport>;
}
const wpCandidatesSchema = z.array(z.object({ id: z.number().int().positive(), link: z.string().url().max(4096) }).strict()).max(10);
const wpProbeSchema = z.array(z.object({ id: z.number().int().positive() }).passthrough()).max(1);
export class ProviderSourceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ProviderSourceError'; }
}
const canonical = (url: string) => {
  try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname.replace(/\/$/, '') || '/'}`; }
  catch { throw new ProviderSourceError('invalid_source_url', 'An external source returned an invalid URL.'); }
};
const WP_ERROR = 'WordPress returned an invalid or unavailable response.';

/** GSC lists URL variants separately; collapse them before choosing articles. */
export function groupPageVariants(rows: GscRow[]): GscRow[] {
  const groups = new Map<string, { representative: GscRow; clicks: number; impressions: number; weightedPosition: number }>();
  for (const row of rows) {
    const key = canonical(row.keys[0]);
    const group = groups.get(key) ?? { representative: row, clicks: 0, impressions: 0, weightedPosition: 0 };
    if (row.impressions > group.representative.impressions) group.representative = row;
    group.clicks += row.clicks;
    group.impressions += row.impressions;
    group.weightedPosition += row.position * row.impressions;
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ keys: group.representative.keys,
    clicks: group.clicks, impressions: group.impressions, ctr: group.clicks / Math.max(1, group.impressions),
    position: group.weightedPosition / Math.max(1, group.impressions) }));
}

export class LiveDataProvider implements DataProvider {
  private google?: GoogleDataReader;
  private fetchImpl: typeof fetch;
  constructor(private config: LiveConfig, private wp: WordPressAdapter, private onPost: (post: WordPressPostSnapshot) => void,
    dependencies: { google?: GoogleDataReader; fetch?: typeof fetch } = {}) {
    this.google = dependencies.google ?? (config.googleServiceAccountKeyPath ? new GoogleReader(config.googleServiceAccountKeyPath) : undefined);
    this.fetchImpl = dependencies.fetch ?? fetch;
  }
  private async wpRequest<T>(path: string, schema: z.ZodType<T>, authenticated = false): Promise<T> {
    try {
      const response = await this.fetchImpl(new URL(path, this.config.siteUrl), { redirect: 'error', signal: AbortSignal.timeout(20000), headers: authenticated ? { Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.appPassword}`).toString('base64')}` } : {} });
      if (!response.ok) throw new Error('upstream response');
      return schema.parse(await response.json());
    } catch { throw new ProviderSourceError('invalid_wordpress_response', WP_ERROR); }
  }
  async check(): Promise<Connection[]> {
    const checkedAt = new Date().toISOString();
    const result: Connection[] = [];
    try {
      await this.wpRequest('/wp-json/wp/v2/posts?context=edit&per_page=1&_fields=id', wpProbeSchema, true);
      result.push({ id: 'wordpress', label: 'WordPress', status: 'ready', checkedAt, message: '授權讀取成功；正式寫回仍須逐篇核准。' });
    } catch { result.push({ id: 'wordpress', label: 'WordPress', status: 'error', checkedAt, message: WP_ERROR }); }
    if (!this.google || !this.config.gscSiteUrl) result.push({ id: 'gsc', label: 'Search Console', status: 'unconfigured', message: '請設定唯讀服務帳號與明確的 Search Console 資源。' });
    else {
      try {
        const sites = await this.google.sites();
        const site = sites.find(site => site.siteUrl === this.config.gscSiteUrl);
        if (!site || site.permissionLevel === 'siteUnverifiedUser') throw new Error('Configured Search Console property is not readable by this service account.');
        result.push({ id: 'gsc', label: 'Search Console', status: 'ready', checkedAt, message: '已確認指定資源的唯讀權限。' });
      } catch (error) { result.push({ id: 'gsc', label: 'Search Console', status: 'error', checkedAt, message: safeSourceMessage('gsc', error) }); }
    }
    if (!this.google || !this.config.ga4PropertyId) result.push({ id: 'ga4', label: 'Google Analytics', status: 'unconfigured', message: '請設定 GA4 屬性與唯讀服務帳號。' });
    else {
      try {
        const { startDate, endDate } = completeWindows();
        await this.google.report(this.config.ga4PropertyId, { dateRanges: [{ startDate, endDate }], metrics: [{ name: 'sessions' }], limit: '1' });
        result.push({ id: 'ga4', label: 'Google Analytics', status: 'ready', checkedAt, message: '唯讀報表可用；閱讀品質仍需通過量測檢查。' });
      } catch (error) { result.push({ id: 'ga4', label: 'Google Analytics', status: 'error', checkedAt, message: safeSourceMessage('ga4', error) }); }
    }
    return result;
  }
  async sync(): Promise<Snapshot> {
    if (!this.google || !this.config.gscSiteUrl) throw new ProviderSourceError('gsc_required', 'Search Console is required for live demand analysis.');
    const windows = completeWindows();
    const fetchedAt = new Date().toISOString();
    const id = randomUUID();
    const gscId = `${id}:gsc`;
    const warnings: string[] = [];
    // Serialize provider requests to avoid adding bursts to existing site operations.
    const current = groupPageVariants(await this.google.search(this.config.gscSiteUrl, windows.startDate, windows.endDate, ['page']));
    const previous = groupPageVariants(await this.google.search(this.config.gscSiteUrl, windows.previousStart, windows.previousEnd, ['page']));
    const previousByUrl = new Map(previous.map(row => [canonical(row.keys[0]), row.clicks]));
    const eligible = current.filter(row => {
      const candidateUrl = new URL(row.keys[0]);
      if (candidateUrl.origin !== this.config.siteUrl || candidateUrl.username || candidateUrl.password || row.impressions < 100) return false;
      const before = previousByUrl.get(canonical(row.keys[0])) ?? 0;
      return (before >= 20 && row.clicks <= before * 0.8) || (row.position >= 4 && row.position <= 20);
    }).sort((a, b) => {
      const decay = (row: typeof a) => { const before = previousByUrl.get(canonical(row.keys[0])) ?? 0; return before >= 20 && row.clicks <= before * 0.8; };
      return Number(decay(b)) - Number(decay(a)) || b.impressions - a.impressions || b.clicks - a.clicks || a.keys[0].localeCompare(b.keys[0]);
    }).slice(0, 10);
    const pages: PageRecord[] = [];
    const search: SearchRow[] = [];
    const pageMetrics: SearchPageRow[] = [];
    for (const row of eligible) {
      const url = new URL(row.keys[0]);
      const slug = url.pathname.split('/').filter(Boolean).at(-1);
      if (!slug) continue;
      let decodedSlug: string;
      try { decodedSlug = decodeURIComponent(slug); }
      catch { throw new ProviderSourceError('invalid_source_slug', 'An external source returned an invalid page slug.'); }
      const candidates = await this.wpRequest(`/wp-json/wp/v2/posts?slug=${encodeURIComponent(decodedSlug)}&_fields=id,link&per_page=10`, wpCandidatesSchema);
      const candidate = candidates.find(post => {
        const link = new URL(post.link);
        return !link.username && !link.password && link.origin === this.config.siteUrl && canonical(post.link) === canonical(url.href);
      });
      if (!candidate) { warnings.push('一個搜尋結果無法安全對應至 WordPress 文章。'); continue; }
      const post = await this.wp.getPostForEdit(candidate.id);
      if (post.status !== 'publish') continue;
      this.onPost(post);
      pages.push({ postId: post.postId, url: post.url, title: post.protectedFields.title, bodyHtml: post.bodyHtml, status: post.status, modified: post.modified, protectedHash: hashPostState(post) });
      // Query coverage is explicitly limited to the largest URL variant.
      const queries = await this.google.search(this.config.gscSiteUrl, windows.startDate, windows.endDate, ['query'], row.keys[0]);
      search.push(...queries.map(query => ({ postId: post.postId, query: query.keys[0], clicks: query.clicks, impressions: query.impressions, position: query.position, previousClicks: 0, evidenceId: gscId })));
      pageMetrics.push({ postId: post.postId, clicks: row.clicks, impressions: row.impressions, position: row.position, previousClicks: previousByUrl.get(canonical(row.keys[0])) ?? 0, evidenceId: gscId });
    }
    const snapshot: Snapshot = {
      id, createdAt: fetchedAt, mode: 'live', pages, search, pageMetrics, analytics: [], warnings,
      evidence: [{ id: gscId, source: 'gsc', property: this.config.gscSiteUrl, startDate: windows.startDate, endDate: windows.endDate, timeZone: 'America/Los_Angeles', fetchedAt, complete: true, coverage: `final 資料；頁面列最多 25000，同路徑的 URL 變體彙總為一篇。查詢詞限該篇曝光最多的 URL 變體、最多 100 筆，非完整查詢詞或全站盤點。前期 ${windows.previousStart} 至 ${windows.previousEnd}。點擊總數取頁面報表，不加總查詢詞。` }],
    };
    if (this.config.ga4PropertyId) {
      try {
        const hostname = new URL(this.config.siteUrl).hostname;
        const valid = await this.google.measurement(this.config.ga4PropertyId, windows.startDate, windows.endDate, hostname);
        const report = await this.google.landingPages(this.config.ga4PropertyId, windows.startDate, windows.endDate, hostname);
        const complete = !report.metadata?.subjectToThresholding && !report.metadata?.dataLossFromOtherRow && !report.metadata?.samplingMetadatas?.length && (report.rowCount ?? 0) <= 10000;
        const gaId = `${id}:ga4`;
        snapshot.evidence.push({ id: gaId, source: 'ga4', property: this.config.ga4PropertyId, startDate: windows.startDate, endDate: windows.endDate, timeZone: report.metadata?.timeZone ?? 'unknown', fetchedAt, complete, coverage: 'Organic Search，限指定 hostname；依落地頁彙總，不與搜尋詞做個人歸因。' });
        snapshot.analytics = (report.rows ?? []).flatMap(row => {
          const page = pages.find(page => canonical(page.url) === canonical(new URL(row.dimensionValues[0].value, this.config.siteUrl).href));
          return page ? [{ postId: page.postId, sessions: Number(row.metricValues[0].value), engagedSessions: Number(row.metricValues[1].value), measurementValid: valid && complete, evidenceId: gaId } satisfies AnalyticsRow] : [];
        });
        const analyticsByPost = new Map<number, AnalyticsRow>();
        for (const row of snapshot.analytics) {
          const existing = analyticsByPost.get(row.postId);
          analyticsByPost.set(row.postId, existing ? { ...row, sessions: existing.sessions + row.sessions, engagedSessions: existing.engagedSessions + row.engagedSessions } : row);
        }
        snapshot.analytics = [...analyticsByPost.values()].map(row => ({ ...row, measurementValid: row.measurementValid && row.engagedSessions <= row.sessions }));
        if (!valid) warnings.push('GA4 自動事件 keyEvents 檢查未通過或沒有足夠資料；閱讀品質標為未知。');
        if (!complete) warnings.push('GA4 報表有抽樣、門檻或列數限制，不用來確認閱讀品質。');
      } catch (error) { warnings.push(`GA4 無法更新：${safeSourceMessage('ga4', error)}`); }
    } else warnings.push('未設定 GA4：可呈現搜尋需求，但閱讀品質未知。');
    return snapshot;
  }
}
