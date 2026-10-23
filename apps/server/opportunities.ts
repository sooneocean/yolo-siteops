import type { Opportunity, Snapshot } from '../../packages/contracts.js';

export function rankOpportunities(snapshot: Snapshot, limit = 10): Opportunity[] {
  const validEvidence = new Set(snapshot.evidence.filter(e => e.complete).map(e => e.id));
  return snapshot.pages.flatMap(page => {
    if (page.status !== 'publish') return [];
    const rows = snapshot.search.filter(row => row.postId === page.postId && validEvidence.has(row.evidenceId));
    if (!rows.length) return [];
    const pageMetrics = snapshot.pageMetrics?.find(row => row.postId === page.postId && validEvidence.has(row.evidenceId));
    if (snapshot.mode === 'live' && !pageMetrics) return [];
    // Live rankings use independent page totals: query rows may omit anonymized searches.
    const impressions = pageMetrics?.impressions ?? rows.reduce((sum, row) => sum + row.impressions, 0);
    const clicks = pageMetrics?.clicks ?? rows.reduce((sum, row) => sum + row.clicks, 0);
    const previousClicks = pageMetrics?.previousClicks ?? rows.reduce((sum, row) => sum + row.previousClicks, 0);
    const position = pageMetrics?.position ?? rows.reduce((sum, row) => sum + row.position * row.impressions, 0) / Math.max(impressions, 1);
    const decay = previousClicks >= 20 && clicks <= previousClicks * 0.8;
    if (impressions < 100 || (!decay && !(position >= 4 && position <= 20))) return [];
    const analytics = snapshot.analytics.find(row => row.postId === page.postId && row.measurementValid && row.sessions >= 10 && validEvidence.has(row.evidenceId));
    const queries = [...new Set(rows.sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query)).map(row => row.query))].slice(0, 100);
    const item: Opportunity = {
      id: `${snapshot.id}:${page.postId}`, postId: page.postId, title: page.title, url: page.url,
      kind: decay ? 'decay' : 'position', clicks, previousClicks, impressions, position, queries,
      evidenceIds: [...new Set([...rows.map(row => row.evidenceId), ...(pageMetrics ? [pageMetrics.evidenceId] : []), ...(analytics ? [analytics.evidenceId] : [])])],
      quality: analytics ? 'available' : 'unknown',
      ...(analytics ? { engagementRate: analytics.engagedSessions / analytics.sessions } : {}),
      reason: decay ? '與前 28 個完整日相比，搜尋點擊下降至少 20%；優先檢視內容是否仍回答需求。' : '已有搜尋曝光，平均排名在 4–20；可檢視內容涵蓋與站內閱讀路徑。',
      audienceHypothesis: `可能正在尋找「${queries[0]}」相關解答的讀者；需以內容與後續觀察驗證。`,
      keywordHypotheses: [],
    };
    return [item];
  }).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'decay' ? -1 : 1) || b.impressions - a.impressions || b.clicks - a.clicks || a.url.localeCompare(b.url)).slice(0, Math.max(0, limit));
}
