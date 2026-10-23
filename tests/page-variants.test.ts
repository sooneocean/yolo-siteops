import { describe, expect, it } from 'vitest';
import { groupPageVariants, LiveDataProvider } from '../apps/server/data/provider.js';
import { rankOpportunities } from '../apps/server/opportunities.js';
import type { GscRow } from '../apps/server/data/google.js';

const row = (url: string, clicks: number, impressions: number, position: number): GscRow => ({ keys: [url], clicks, impressions, position, ctr: clicks / impressions });

describe('canonical page opportunities', () => {
  it('collapses query/slash variants before ranking without losing page totals', () => {
    const grouped = groupPageVariants([
      row('https://example.test/article/?variant=1', 10, 100, 5),
      row('https://example.test/article', 20, 200, 8),
      row('https://example.test/article/?variant=2', 30, 300, 9),
      row('https://example.test/another/', 5, 100, 4),
    ]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toEqual({ keys: ['https://example.test/article/?variant=2'], clicks: 60, impressions: 600, ctr: 0.1, position: 8 });
    expect(grouped[1].clicks).toBe(5);
  });
  it('keeps different origins and different paths separate', () => {
    expect(groupPageVariants([
      row('https://example.test/a', 1, 100, 4), row('https://other.test/a', 1, 100, 4), row('https://example.test/b', 1, 100, 4),
    ])).toHaveLength(3);
  });
  it('maps ten URL variants to one article and one bounded query request', async () => {
    let queryRequests = 0;
    let reads = 0;
    const provider = new LiveDataProvider({ siteUrl: 'https://example.test', username: 'fixture', appPassword: 'fixture', gscSiteUrl: 'https://example.test/' }, {
      getPostForEdit: async () => { reads++; return { postId: 1, url: 'https://example.test/article/', bodyHtml: '<p>Fixture</p>', status: 'publish', modified: '2026-01-01', protectedFields: { title: 'Fixture', slug: 'article', excerpt: '', categories: [], tags: [], featured_media: 0, meta: {} } }; },
      updateBody: async () => { throw new Error('No writes allowed'); },
      checkPublicReadback: async () => { throw new Error('No write readback expected'); },
    }, () => undefined, {
      fetch: async () => Response.json([{ id: 1, link: 'https://example.test/article/' }]),
      google: {
        sites: async () => [], report: async () => ({}), measurement: async () => false, landingPages: async () => ({}),
        search: async (_site, _start, _end, dimensions) => {
          if (dimensions[0] === 'page') return Array.from({ length: 10 }, (_, index) => row(`https://example.test/article/?variant=${index}`, 2, 100, 8));
          queryRequests++;
          return Array.from({ length: 100 }, (_, index) => row(`query-${index}`, 1, 10, 8));
        },
      },
    });
    const snapshot = await provider.sync();
    expect(snapshot.pages).toHaveLength(1);
    expect(rankOpportunities(snapshot)).toHaveLength(1);
    expect(snapshot.pageMetrics?.[0]).toMatchObject({ clicks: 20, impressions: 1000 });
    expect(snapshot.search).toHaveLength(100);
    expect(queryRequests).toBe(1);
    expect(reads).toBe(1);
  });
});
