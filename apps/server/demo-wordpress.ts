import type { Connection, PageRecord, Snapshot } from '../../packages/contracts.js';
import { makeDemoSnapshot } from './demo.js';
import type { DataProvider } from './data/provider.js';
import { Store } from './store.js';
import { normalizeHtmlText } from './security/html.js';
import { hashPostState } from './writer/hash.js';
import type { PublicReadback, WordPressAdapter, WordPressPostSnapshot } from './writer/types.js';

const KIND = 'private_wp_snapshot';

function snapshotFromPage(page: PageRecord): WordPressPostSnapshot {
  const slug = new URL(page.url).pathname.split('/').filter(Boolean).at(-1) ?? String(page.postId);
  return {
    postId: page.postId,
    url: page.url,
    bodyHtml: page.bodyHtml,
    status: page.status,
    modified: page.modified,
    protectedFields: {
      slug,
      title: page.title,
      excerpt: '',
      categories: [1],
      tags: [],
      featured_media: 0,
      meta: {},
    },
  };
}

export class DemoWordPressAdapter implements WordPressAdapter {
  constructor(private readonly store: Store, private readonly now: () => Date = () => new Date()) {}

  seedPage(page: PageRecord): WordPressPostSnapshot {
    const id = String(page.postId);
    const existing = this.store.get<WordPressPostSnapshot>(KIND, id);
    if (existing) return existing;
    const post = snapshotFromPage(page);
    this.store.put(KIND, id, post);
    return post;
  }

  async getPostForEdit(postId: number): Promise<WordPressPostSnapshot> {
    const post = this.store.get<WordPressPostSnapshot>(KIND, String(postId));
    if (!post) throw new Error('Demo WordPress post was not found');
    return structuredClone(post);
  }

  async updateBody(postId: number, bodyHtml: string): Promise<void> {
    const post = await this.getPostForEdit(postId);
    this.store.put<WordPressPostSnapshot>(KIND, String(postId), {
      ...post,
      bodyHtml,
      modified: this.now().toISOString(),
    });
  }

  async checkPublicReadback(post: WordPressPostSnapshot): Promise<PublicReadback> {
    return post.status === 'publish'
      ? { visibility: 'public', statusCode: 200, url: post.url, normalizedText: normalizeHtmlText(post.bodyHtml) }
      : { visibility: 'isolated', statusCode: 404, url: post.url };
  }
}

export class DemoDataProvider implements DataProvider {
  constructor(private readonly wordpress: DemoWordPressAdapter, private readonly now: () => Date = () => new Date()) {}

  async check(): Promise<Connection[]> {
    const checkedAt = this.now().toISOString();
    return [
      { id: 'wordpress', label: 'WordPress', status: 'ready', checkedAt, message: 'Demo adapter ready; no live website is connected.' },
      { id: 'gsc', label: 'Search Console', status: 'ready', checkedAt, message: 'Synthetic demo evidence is available.' },
      { id: 'ga4', label: 'Google Analytics', status: 'ready', checkedAt, message: 'Synthetic demo analytics are available.' },
    ];
  }

  async sync(): Promise<Snapshot> {
    const snapshot = makeDemoSnapshot(this.now());
    snapshot.pages = await Promise.all(snapshot.pages.map(async (page) => {
      const post = this.wordpress.seedPage(page);
      return {
        ...page,
        bodyHtml: post.bodyHtml,
        status: post.status,
        modified: post.modified,
        title: post.protectedFields.title,
        url: post.url,
        protectedHash: hashPostState(post),
      };
    }));
    return snapshot;
  }
}
