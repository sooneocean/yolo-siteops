import { createHash } from 'node:crypto';
import type { Snapshot } from '../../packages/contracts.js';
export const hashValue = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function makeDemoSnapshot(now = new Date()): Snapshot {
  const date = (days: number) => new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  const fetchedAt = now.toISOString();
  const topics = [
    ['選擇適合自己的筆記工具', '筆記工具比較', 62, 108, 1840, 7.4],
    ['如何建立每週閱讀習慣', '閱讀習慣養成', 49, 54, 1260, 5.8],
    ['為長文章安排清楚的段落', '長文段落規劃', 31, 33, 860, 9.2],
  ] as const;
  return {
    id: `demo-${now.toISOString()}`, mode: 'demo', createdAt: fetchedAt,
    evidence: [
      { id: 'demo-gsc', source: 'gsc', property: 'https://example.test', startDate: date(30), endDate: date(3), timeZone: 'America/Los_Angeles', fetchedAt, complete: true, coverage: '合成資料；不代表任何網站流量。比較期間為前 28 日。' },
      { id: 'demo-ga4', source: 'ga4', property: 'demo-property', startDate: date(30), endDate: date(3), timeZone: 'Asia/Taipei', fetchedAt, complete: true, coverage: '合成資料；自然搜尋落地頁彙總。' },
    ],
    pages: topics.map((topic, index) => {
      const bodyHtml = `<h2>${topic[0]}</h2><p>先寫下自己要解決的問題，再選擇適合的做法。每週保留一段時間回顧實際使用經驗。</p><h2>從小步驟開始</h2><p>挑選一個容易持續的方法，記錄遇到的困難，並根據記錄調整。</p>`;
      return { postId: index + 1, url: `https://example.test/guides/${index + 1}`, title: topic[0], bodyHtml, status: 'publish', modified: fetchedAt, protectedHash: hashValue({ bodyHtml, status: 'publish' }) };
    }),
    search: topics.map((topic, index) => ({ postId: index + 1, query: topic[1], clicks: topic[2], previousClicks: topic[3], impressions: topic[4], position: topic[5], evidenceId: 'demo-gsc' })),
    analytics: topics.map((_, index) => ({ postId: index + 1, sessions: 80 - index * 15, engagedSessions: 46 - index * 8, measurementValid: true, evidenceId: 'demo-ga4' })),
    warnings: ['目前為示範模式：所有流量與文章均為合成資料，不會修改真實網站。'],
  };
}
